import { Linking, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as IntentLauncher from 'expo-intent-launcher';
import { getIosAccuracy, pedirPrecisaoTotalIos, type IosAccuracy } from '../../modules/location-accuracy';

export type LocationPayload = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
};

export type LocationResult =
  | { ok: true; location: LocationPayload }
  | { ok: false; error: string };

export async function requestLocationPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

/**
 * Estado bruto da localização, pra web distinguir as CAUSAS de "sem GPS" em vez
 * de tratar tudo como sinal fraco: serviço desligado, permissão negada e
 * permissão só aproximada dão o mesmo sintoma na tela mas exigem ações
 * diferentes do usuário.
 *
 * `androidAccuracy: 'coarse'` é o caso traiçoeiro — o Android borra a posição
 * pra ~1-3 km de propósito, então o gate de check-in (150 m) nunca libera por
 * mais que o promotor ande até a porta da loja.
 *
 * No iOS o expo-location expõe só o `scope` (whenInUse/always), NÃO o
 * `accuracyAuthorization` — esse vem do módulo nativo `location-accuracy` em
 * `iosAccuracy`, e é o espelho exato do `androidAccuracy`: `reduced` lá é o
 * mesmo caso do `coarse` aqui. Em binário sem o módulo vem null, e aí a web
 * volta a inferir precisão reduzida pela accuracy travada em quilômetros.
 */
export type LocationDiagnostics = {
  platform: 'android' | 'ios' | 'other';
  servicesEnabled: boolean;
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
  androidAccuracy: 'fine' | 'coarse' | 'none' | null;
  iosScope: 'whenInUse' | 'always' | 'none' | null;
  iosAccuracy: IosAccuracy | null;
};

/**
 * @param request quando true, dispara o diálogo nativo de permissão antes de
 * ler o estado — só tem efeito se o sistema ainda aceitar perguntar.
 */
export async function getLocationDiagnostics(request = false): Promise<LocationDiagnostics> {
  const plataforma: LocationDiagnostics['platform'] =
    Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'other';

  let perm = await Location.getForegroundPermissionsAsync();
  if (request && perm.status !== 'granted' && perm.canAskAgain) {
    perm = await Location.requestForegroundPermissionsAsync();
  }

  let servicesEnabled = false;
  try {
    servicesEnabled = await Location.hasServicesEnabledAsync();
  } catch {
    // Alguns fabricantes lançam aqui quando o serviço está off — trata como off.
  }

  return {
    platform: plataforma,
    servicesEnabled,
    status:
      perm.status === 'granted'
        ? 'granted'
        : perm.status === 'denied'
          ? 'denied'
          : 'undetermined',
    canAskAgain: perm.canAskAgain,
    androidAccuracy: perm.android?.accuracy ?? null,
    iosScope: perm.ios?.scope ?? null,
    // Sem permissão concedida o valor não significa nada (o iOS reporta
    // `reduced` por padrão), e acusaria "Localização Exata desligada" pra quem
    // na verdade nem liberou a localização ainda.
    iosAccuracy: perm.status === 'granted' ? await getIosAccuracy() : null,
  };
}

/**
 * Diálogo do sistema que liga a "Localização Exata" sem sair do app. `false`
 * quando o usuário recusa ou o binário não tem o módulo — aí sobra os Ajustes.
 */
export async function requestIosFullAccuracy(): Promise<boolean> {
  return pedirPrecisaoTotalIos();
}

/**
 * Abre a tela de configuração relevante. `services` = onde se liga a
 * localização do aparelho; `app` = permissões deste app (onde se troca
 * aproximada por precisa).
 */
export async function openLocationSettings(
  target: 'app' | 'services',
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (target === 'services' && Platform.OS === 'android') {
      await IntentLauncher.startActivityAsync('android.settings.LOCATION_SOURCE_SETTINGS');
      return { ok: true };
    }
    // App settings serve pros dois casos no iOS (não há intent pra tela de
    // serviços) e pro caso 'app' no Android.
    await Linking.openSettings();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Não foi possível abrir as configurações.',
    };
  }
}

export async function getCurrentLocation(): Promise<LocationResult> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      const granted = await requestLocationPermission();
      if (!granted) return { ok: false, error: 'Permissão de localização negada.' };
    }

    const services = await Location.hasServicesEnabledAsync();
    if (!services) return { ok: false, error: 'Serviços de localização desativados.' };

    // High (GPS + fused), não Balanced (~100 m): o raio alimenta o gate de
    // check-in de 150 m — Balanced falha na margem.
    // Fix fresco a frio pode passar do orçamento do front (8–10 s) e derrubar
    // o caller no navigator do WKWebView (a fonte ruim). Se demorar, serve o
    // last-known recente do sistema e deixa o watch refinar depois.
    const fresh = Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    let position = await Promise.race([
      fresh,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    if (!position) {
      position = await Location.getLastKnownPositionAsync({ maxAge: 120_000 });
    }
    if (!position) {
      position = await fresh;
    }

    return {
      ok: true,
      location: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        heading: position.coords.heading,
        speed: position.coords.speed,
        timestamp: position.timestamp,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function watchLocation(
  onUpdate: (payload: LocationPayload) => void,
  onError?: (error: string) => void,
): Promise<Location.LocationSubscription | null> {
  return Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: 15000,
      // 0, não 25: o iOS ignora timeInterval e só respeita o filtro de
      // distância — com 25 m o promotor parado no PDV nunca recebia o
      // refinamento do fix e o gate de check-in (accuracy ≤ 150) não liberava.
      distanceInterval: 0,
    },
    (position) => {
      onUpdate({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        altitude: position.coords.altitude,
        heading: position.coords.heading,
        speed: position.coords.speed,
        timestamp: position.timestamp,
      });
    },
    (reason) => {
      // Sem isso, falha no MEIO do watch era silenciosa e o front segurava
      // o último fix como se fosse atual.
      onError?.(reason);
    },
  ).catch((error) => {
    onError?.(error instanceof Error ? error.message : String(error));
    return null;
  });
}
