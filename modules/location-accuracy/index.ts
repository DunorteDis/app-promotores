import { requireOptionalNativeModule } from 'expo';

export type IosAccuracy = 'full' | 'reduced' | 'unknown';

type LocationAccuracyNative = {
  getAccuracyAuthorization(): Promise<IosAccuracy>;
  requestTemporaryFullAccuracy(purposeKey: string): Promise<boolean>;
};

/**
 * `Optional` de propósito: o módulo é iOS-only (ver expo-module.config.json), e
 * no Android `requireNativeModule` lançaria. Null aqui = "não dá pra saber",
 * que é exatamente o que o Android já responde por outro caminho.
 */
const nativo = requireOptionalNativeModule<LocationAccuracyNative>('LocationAccuracy');

/** Precisão concedida a ESTE app no iOS, ou null fora do iOS/em build sem o módulo. */
export async function getIosAccuracy(): Promise<IosAccuracy | null> {
  if (!nativo) return null;
  try {
    return await nativo.getAccuracyAuthorization();
  } catch {
    return null;
  }
}

/**
 * Diálogo do sistema que liga a precisão total. Resolve com `true` se ficou
 * exata. `false` = usuário recusou ou o módulo não existe — nos dois casos
 * sobra mandar o promotor pros Ajustes.
 *
 * `purposeKey` precisa bater com uma chave declarada em
 * `NSLocationTemporaryUsageDescriptionDictionary` no Info.plist.
 */
export async function pedirPrecisaoTotalIos(purposeKey = 'checkinVisita'): Promise<boolean> {
  if (!nativo) return false;
  try {
    return await nativo.requestTemporaryFullAccuracy(purposeKey);
  } catch {
    return false;
  }
}
