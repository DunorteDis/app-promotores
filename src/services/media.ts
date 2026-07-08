import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Video as VideoCompressor } from 'react-native-compressor';
import * as Sharing from 'expo-sharing';
import * as IntentLauncher from 'expo-intent-launcher';

export type MediaFile = {
  base64: string;
  mimeType: string;
  fileName: string;
};

export type MediaPickResult =
  | { ok: true; files: MediaFile[] }
  | { ok: false; error: string };

export async function captureImage(): Promise<MediaPickResult> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Permissão necessária',
      'Permita o acesso à câmera nas configurações do dispositivo.',
    );
    return { ok: false, error: 'Permissão de câmera negada.' };
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.7,
    base64: true,
    exif: false,
  });

  if (result.canceled) return { ok: true, files: [] };

  return {
    ok: true,
    files: result.assets.map((asset) => ({
      base64: asset.base64 ?? '',
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileName: asset.fileName ?? `photo_${Date.now()}.jpg`,
    })),
  };
}

export async function pickImages(multiple: boolean): Promise<MediaPickResult> {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Permissão necessária',
      'Permita o acesso à galeria nas configurações do dispositivo.',
    );
    return { ok: false, error: 'Permissão de galeria negada.' };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: multiple,
    quality: 0.7,
    base64: true,
    exif: false,
  });

  if (result.canceled) return { ok: true, files: [] };

  return {
    ok: true,
    files: result.assets.map((asset) => ({
      base64: asset.base64 ?? '',
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileName: asset.fileName ?? `image_${Date.now()}.jpg`,
    })),
  };
}

export type VideoRecordResult =
  | { ok: true; cancelled: true }
  | {
      ok: true;
      cancelled: false;
      uploaded: boolean;
      mimeType: string;
      fileName: string;
      sizeBytes: number | null;
      durationMs: number | null;
    }
  | { ok: false; error: string };

/**
 * Grava um vídeo com a câmera nativa do sistema e sobe o arquivo DIRETO pro
 * `uploadUrl` (presigned PUT do S3), sem passar pela WebView. Vídeo é grande
 * demais pra trafegar em base64 pela bridge — por isso o upload nativo é
 * obrigatório: a web pede a presigned URL ao backend, chama a bridge e recebe
 * só o resultado do upload.
 */
// ponytail: câmera do SISTEMA via image picker (UI pronta, gravar/rever/refazer);
// se um dia precisar de UI própria (contador, limite visual), migrar pra
// gravação no CameraSessionVision (vision-camera já suporta).
export async function recordVideo(payload: {
  maxDurationSec?: number;
  uploadUrl: string;
  /** Content-Type assinado no presign — o PUT PRECISA mandar exatamente esse header. */
  contentType?: string;
}): Promise<VideoRecordResult> {
  if (!payload?.uploadUrl) {
    return { ok: false, error: 'uploadUrl é obrigatório (vídeo não trafega em base64 pela bridge).' };
  }

  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Permissão necessária',
      'Permita o acesso à câmera nas configurações do dispositivo.',
    );
    return { ok: false, error: 'Permissão de câmera negada.' };
  }

  const maxDurationSec = Math.max(5, Math.min(300, Number(payload.maxDurationSec) || 60));

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    videoMaxDuration: maxDurationSec,
    // iOS: limita a 720p (arquivo menor pra rede de campo). Android ignora —
    // a câmera do sistema grava no padrão dela.
    videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
  });

  if (result.canceled) return { ok: true, cancelled: true };

  const asset = result.assets[0];
  const mimeType = asset.mimeType ?? 'video/mp4';
  // Header do PUT = o Content-Type que a web assinou no presign (S3 rejeita se
  // divergir); o mimeType real do arquivo vai na resposta pra web decidir.
  const putContentType = payload.contentType || mimeType;

  // Comprime antes do upload (estilo WhatsApp): a câmera do sistema grava
  // ~1080p com bitrate alto (60s ≈ 60-100MB) — reescala pra 720p/2Mbps H.264,
  // ~15MB/min, viável no 4G de campo. Falhou a compressão? Sobe o original
  // (pior em dados, melhor que perder o vídeo).
  let uploadUri = asset.uri;
  let sizeBytes: number | null = asset.fileSize ?? null;
  try {
    uploadUri = await VideoCompressor.compress(asset.uri, {
      compressionMethod: 'manual',
      maxSize: 1280,
      bitrate: 2_000_000,
    });
    const info = await FileSystem.getInfoAsync(uploadUri);
    if (info.exists && typeof info.size === 'number') sizeBytes = info.size;
  } catch {
    uploadUri = asset.uri;
  }

  try {
    const upload = await FileSystem.uploadAsync(payload.uploadUrl, uploadUri, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': putContentType },
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    });
    if (upload.status < 200 || upload.status >= 300) {
      return { ok: false, error: `Falha no upload do vídeo (HTTP ${upload.status}).` };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Falha no upload do vídeo.',
    };
  }

  return {
    ok: true,
    cancelled: false,
    uploaded: true,
    mimeType,
    fileName: asset.fileName ?? `video_${Date.now()}.mp4`,
    sizeBytes,
    durationMs: asset.duration ?? null,
  };
}

export type OpenFileResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Salva um arquivo (base64) no cache do app e abre o picker nativo
 * "Abrir com…" pra o usuário escolher visualizador (Adobe Reader, Drive,
 * etc.). Usado pra materiais (planograma/catálogo) que não dá pra abrir
 * direto na WebView (sem visualizador embutido + target=_blank bloqueado).
 *
 * Sanitiza o filename pra evitar path traversal / chars proibidos do FS.
 */
export async function openFile(payload: {
  base64: string;
  mimeType?: string;
  fileName?: string;
}): Promise<OpenFileResult> {
  try {
    if (!payload?.base64) {
      return { ok: false, error: 'Arquivo vazio.' };
    }

    // Sanitiza nome do arquivo (só basename, sem path; chars seguros).
    const rawName = payload.fileName?.trim() || `arquivo_${Date.now()}`;
    const baseName = rawName.split(/[\\/]/).pop() ?? rawName;
    const safeName = baseName.replace(/[^\w.\-]/g, '_').slice(0, 120) || `arquivo_${Date.now()}`;

    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) {
      return { ok: false, error: 'Cache do app indisponível.' };
    }

    const dir = cacheDir + 'materiais/';
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }

    const fileUri = dir + safeName;
    await FileSystem.writeAsStringAsync(fileUri, payload.base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // No Android, usamos ACTION_VIEW via IntentLauncher.startActivityAsync com
    // content:// URI e flag FLAG_GRANT_READ_URI_PERMISSION (=1). Isso lista
    // APENAS apps que sabem ABRIR o arquivo (visualizadores de PDF, Drive, etc.)
    // — sem opções de "compartilhar" tipo email/WhatsApp, que o Sharing.shareAsync
    // (ACTION_SEND) trazia e confundia o usuário.
    //
    // Importante: o `flags: 1` é obrigatório. Sem ele, o leitor escolhido recebe
    // o content URI mas é bloqueado pelo Android ao tentar ler ("arquivo não
    // existe" ou voltar pra tela anterior sem abrir). Linking.openURL não
    // permite passar flags — por isso precisamos do expo-intent-launcher aqui.
    if (Platform.OS === 'android') {
      try {
        const contentUri = await FileSystem.getContentUriAsync(fileUri);
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          type: payload.mimeType || undefined,
          flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
        });
        return { ok: true };
      } catch {
        // Falha (sem app pra visualizar, etc.) — fallback pro Sharing.
      }
    }

    // iOS + fallback Android (sem visualizador instalado): Sharing.shareAsync.
    // No iOS a sheet nativa já mostra "Abrir em..." como ação primária, então
    // a UX fica natural por lá.
    const sharingAvailable = await Sharing.isAvailableAsync();
    if (!sharingAvailable) {
      return {
        ok: false,
        error: 'Nenhum app instalado pra abrir este tipo de arquivo.',
      };
    }
    await Sharing.shareAsync(fileUri, {
      mimeType: payload.mimeType || undefined,
      dialogTitle: 'Abrir arquivo',
      UTI: payload.mimeType === 'application/pdf' ? 'com.adobe.pdf' : undefined,
    });

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Falha ao abrir arquivo.',
    };
  }
}
