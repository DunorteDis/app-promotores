import { requireOptionalNativeModule } from 'expo';

export type InfoPlay = { disponivel: boolean; versionCode: number };

export type ResultadoPlay =
  | 'aceita' // tocou em "Atualizar"
  | 'recusada' // fechou / "Agora não"
  | 'baixando' // flexível já aceito, download em andamento
  | 'baixada' // flexível já baixado, falta reiniciar
  | 'indisponivel' // Play sem versão nova, ou tipo não permitido
  | 'falhou';

type PlayUpdateNative = {
  verificar(): Promise<InfoPlay | null>;
  iniciar(tipo: 'imediato' | 'flexivel'): Promise<ResultadoPlay>;
  concluir(): Promise<void>;
  addListener(evento: 'onBaixada', cb: () => void): { remove(): void };
};

/**
 * `Optional` de propósito: o módulo é Android-only (ver expo-module.config.json)
 * e no iOS `requireNativeModule` lançaria. Null aqui = "sem Play", e a web segue
 * o fluxo do link.
 */
const nativo = requireOptionalNativeModule<PlayUpdateNative>('PlayUpdate');

/** Versão disponível na Play, ou null se o app não veio dela (APK, iOS) ou ela não respondeu. */
export async function verificarPlay(): Promise<InfoPlay | null> {
  if (!nativo) return null;
  try {
    return await nativo.verificar();
  } catch {
    return null;
  }
}

/** Abre o modal da Play: imediato (tela cheia, bloqueia) ou flexível (baixa por trás). */
export async function iniciarPlay(tipo: 'imediato' | 'flexivel'): Promise<ResultadoPlay> {
  if (!nativo) return 'indisponivel';
  try {
    return await nativo.iniciar(tipo);
  } catch {
    return 'falhou';
  }
}

/** Instala o que o flexível baixou. A Play reinicia o app. */
export async function concluirPlay(): Promise<void> {
  await nativo?.concluir();
}

/** Avisa quando o download flexível termina. Devolve a função que para de ouvir. */
export function aoBaixarPlay(cb: () => void): () => void {
  const sub = nativo?.addListener('onBaixada', cb);
  return () => sub?.remove();
}
