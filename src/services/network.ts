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

export async function getNetworkSnapshot(): Promise<NetworkSnapshot> {
  const state = await NetInfo.fetch();
  return toSnapshot(state);
}

export function subscribeNetwork(onChange: (snapshot: NetworkSnapshot) => void) {
  return NetInfo.addEventListener((state) => onChange(toSnapshot(state)));
}
