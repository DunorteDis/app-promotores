import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

export type NetworkSnapshot = {
  isConnected: boolean;
  isInternetReachable: boolean | null;
  type: string;
  details: Record<string, unknown> | null;
};

function toSnapshot(state: NetInfoState): NetworkSnapshot {
  return {
    isConnected: Boolean(state.isConnected),
    isInternetReachable: state.isInternetReachable,
    type: state.type,
    details: (state.details as Record<string, unknown> | null) ?? null,
  };
}

// Sonda de alcançabilidade apontando pro PRÓPRIO front, não pro endpoint
// padrão do Google (connectivitycheck.gstatic.com): em 5G com IPv6/CGNAT,
// DNS privado ou operadora que degrada esse endpoint, a sonda do Google
// falha com o Vexo funcionando → banner falso de "sem conexão".
// shortTimeout = 5s: enquanto offline, o NetInfo re-testa sozinho a cada 5s —
// é o que garante que o banner destrave sem depender de novo evento de rede.
export function configureNetworkProbe(url: string) {
  NetInfo.configure({
    reachabilityUrl: url,
    // Qualquer resposta HTTP do servidor (mesmo 4xx) prova que ele está
    // alcançável; só 5xx/timeout contam como fora.
    reachabilityTest: async (response) => response.status < 500,
    reachabilityRequestTimeout: 10_000,
    reachabilityShortTimeout: 5_000,
    reachabilityLongTimeout: 60_000,
    // Ignora o veredito nativo do Android (rede "não-validada" por segundos
    // após handover 5G↔4G ficava preso em isInternetReachable=false).
    useNativeReachability: false,
  });
}

export async function getNetworkSnapshot(): Promise<NetworkSnapshot> {
  const state = await NetInfo.fetch();
  return toSnapshot(state);
}

export function subscribeNetwork(onChange: (snapshot: NetworkSnapshot) => void) {
  return NetInfo.addEventListener((state) => onChange(toSnapshot(state)));
}
