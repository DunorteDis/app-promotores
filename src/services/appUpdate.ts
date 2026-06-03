import { Linking, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

export type UpdateProgress = {
  loaded: number;
  total: number | null;
  percent: number | null;
};

export type UpdateResult =
  | { ok: true }
  | { ok: false; error: string; cancelled?: boolean };

// Mantém o download em andamento pra permitir cancelamento via ponte
// (app.cancelUpdate). Só um update roda por vez.
let activeDownload: ReturnType<typeof FileSystem.createDownloadResumable> | null = null;
let cancelled = false;

export function cancelAppUpdate(): void {
  cancelled = true;
  activeDownload?.cancelAsync().catch(() => {
    // best-effort: se já terminou, ignora.
  });
  activeDownload = null;
}

/**
 * Baixa o APK da nova versão direto pro disco (sem segurar tudo em memória,
 * porque o APK passa de 100MB) e, ao terminar, dispara o instalador de pacotes
 * do Android via ACTION_VIEW + content:// URI (mesma estratégia do openFile dos
 * materiais, mas com o mime de APK pra cair no PackageInstaller).
 *
 * `onProgress` é chamado a cada chunk pra alimentar a barra na WebView.
 *
 * iOS não instala APK por sideload — lá apenas abre o link (loja/TestFlight).
 */
export async function downloadAndInstallApk(
  url: string,
  onProgress: (p: UpdateProgress) => void,
): Promise<UpdateResult> {
  // Valida o protocolo antes de qualquer coisa.
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'Link de atualização inválido.' };
    }
  } catch {
    return { ok: false, error: 'Link de atualização inválido.' };
  }

  // iOS: não dá pra instalar .ipa/.apk por sideload — manda pro navegador/loja.
  if (Platform.OS !== 'android') {
    try {
      await Linking.openURL(url);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Não foi possível abrir o link de atualização.' };
    }
  }

  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) {
    return { ok: false, error: 'Cache do app indisponível.' };
  }

  try {
    const dir = cacheDir + 'updates/';
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }

    const fileUri = dir + 'vexo-update.apk';
    // Limpa sobra de um download anterior pra nunca instalar um APK velho/parcial.
    const prev = await FileSystem.getInfoAsync(fileUri);
    if (prev.exists) {
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
    }

    cancelled = false;
    onProgress({ loaded: 0, total: null, percent: 0 });

    const resumable = FileSystem.createDownloadResumable(
      url,
      fileUri,
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        const total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : null;
        onProgress({
          loaded: totalBytesWritten,
          total,
          percent: total
            ? Math.min(100, Math.round((totalBytesWritten / total) * 100))
            : null,
        });
      },
    );
    activeDownload = resumable;

    const result = await resumable.downloadAsync();
    activeDownload = null;

    if (cancelled) {
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
      return { ok: false, error: 'Download cancelado.', cancelled: true };
    }
    if (!result?.uri) {
      return { ok: false, error: 'Falha ao baixar a atualização.' };
    }

    // Dispara o instalador. O content URI vem do FileProvider do app; o
    // flag 1 (FLAG_GRANT_READ_URI_PERMISSION) deixa o PackageInstaller ler
    // o arquivo. Requer a permissão REQUEST_INSTALL_PACKAGES no manifest.
    const contentUri = await FileSystem.getContentUriAsync(result.uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      flags: 1,
    });

    return { ok: true };
  } catch (error) {
    activeDownload = null;
    if (cancelled) {
      return { ok: false, error: 'Download cancelado.', cancelled: true };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Falha ao baixar a atualização.',
    };
  }
}
