import * as Location from 'expo-location';

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
