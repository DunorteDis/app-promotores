import { Alert, Linking, Platform } from 'react-native';
import * as Application from 'expo-application';

import { concluirPlay, iniciarPlay, type ResultadoPlay } from '../../modules/play-update';

export type AppVersionInfo = {
  /** Ex.: "1.0.9" — o que o usuário vê e o que comparamos com o servidor. */
  versionName: string | null;
  /** Android: versionCode. iOS: CFBundleVersion. Só informativo. */
  buildNumber: string | null;
  platform: 'android' | 'ios' | 'other';
};

/**
 * Versão instalada, lida do pacote nativo — não do app.json.
 *
 * A WebView não tem como saber isso sozinha, e sem esse dado o front não
 * consegue comparar com a versão publicada pra decidir se avisa (ou bloqueia).
 * Vem do pacote de propósito: é a única fonte que reflete o APK realmente
 * instalado, mesmo quando o app.json do repositório já está adiantado.
 */
export function getAppVersion(): AppVersionInfo {
  return {
    versionName: Application.nativeApplicationVersion,
    buildNumber: Application.nativeBuildVersion,
    platform: Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'other',
  };
}

export type UpdateResult = { ok: true } | { ok: false; error: string };

/**
 * Abre o link da nova versão (loja ou navegador). Não baixa nem instala nada:
 * app distribuído pela Play não pode se atualizar por fora (política "Device
 * and Network Abuse"), e sem REQUEST_INSTALL_PACKAGES o PackageInstaller
 * recusa o APK. Para sideload, o navegador baixa o APK e o usuário instala.
 */
export async function openUpdateLink(url: string): Promise<UpdateResult> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'Link de atualização inválido.' };
    }
  } catch {
    return { ok: false, error: 'Link de atualização inválido.' };
  }

  try {
    await Linking.openURL(url);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Não foi possível abrir o link de atualização.' };
  }
}

let perguntandoReinicio = false;

/**
 * O download flexível da Play terminou: falta reiniciar o app pra instalar.
 * Pergunta em vez de reiniciar direto — o promotor pode estar no meio de uma
 * visita. "Depois" não perde nada: a próxima abertura do app pergunta de novo.
 */
export function pedirReinicioPlay(): void {
  if (perguntandoReinicio) return; // ouvinte e checagem da web podem chegar juntos
  perguntandoReinicio = true;
  const fechar = () => {
    perguntandoReinicio = false;
  };
  Alert.alert(
    'Atualização baixada',
    'Reinicie o Vexo para usar a nova versão.',
    [
      { text: 'Depois', style: 'cancel', onPress: fechar },
      {
        text: 'Reiniciar',
        onPress: () => {
          fechar();
          concluirPlay().catch(() => {});
        },
      },
    ],
    { cancelable: true, onDismiss: fechar },
  );
}

/** Abre o modal da Play. Se o flexível já tinha baixado, só falta reiniciar. */
export async function atualizarPelaPlay(tipo: 'imediato' | 'flexivel'): Promise<ResultadoPlay> {
  const resultado = await iniciarPlay(tipo);
  if (resultado === 'baixada' && tipo === 'flexivel') pedirReinicioPlay();
  return resultado;
}
