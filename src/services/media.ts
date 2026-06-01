import { Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';

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

    // No Android, usamos ACTION_VIEW via Linking.openURL com content:// URI.
    // Isso lista APENAS apps que sabem ABRIR o arquivo (visualizadores de PDF,
    // Drive, etc.) — sem opções de "compartilhar" tipo email/WhatsApp, que
    // o Sharing.shareAsync (ACTION_SEND) trazia e confundia o usuário.
    if (Platform.OS === 'android') {
      try {
        const contentUri = await FileSystem.getContentUriAsync(fileUri);
        const canOpen = await Linking.canOpenURL(contentUri);
        if (canOpen) {
          await Linking.openURL(contentUri);
          return { ok: true };
        }
        // Sem app pra visualizar — cai pro Sharing como fallback final.
      } catch {
        // Falha no Linking — fallback pro Sharing.
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
