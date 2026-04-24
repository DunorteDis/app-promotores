import * as Battery from 'expo-battery';

export type BatterySnapshot = {
  level: number;
  percent: number;
  state: 'unknown' | 'unplugged' | 'charging' | 'full';
  lowPowerMode: boolean;
};

const stateMap: Record<number, BatterySnapshot['state']> = {
  [Battery.BatteryState.UNKNOWN]: 'unknown',
  [Battery.BatteryState.UNPLUGGED]: 'unplugged',
  [Battery.BatteryState.CHARGING]: 'charging',
  [Battery.BatteryState.FULL]: 'full',
};

export async function getBatterySnapshot(): Promise<BatterySnapshot> {
  const [level, state, lowPowerMode] = await Promise.all([
    Battery.getBatteryLevelAsync(),
    Battery.getBatteryStateAsync(),
    Battery.isLowPowerModeEnabledAsync(),
  ]);

  return {
    level,
    percent: Math.round(level * 100),
    state: stateMap[state] ?? 'unknown',
    lowPowerMode,
  };
}

export function subscribeBattery(onChange: (snapshot: BatterySnapshot) => void) {
  const levelSub = Battery.addBatteryLevelListener(({ batteryLevel }) => {
    void getBatterySnapshot().then(onChange);
    void batteryLevel;
  });

  const stateSub = Battery.addBatteryStateListener(() => {
    void getBatterySnapshot().then(onChange);
  });

  const powerSub = Battery.addLowPowerModeListener(() => {
    void getBatterySnapshot().then(onChange);
  });

  return () => {
    levelSub.remove();
    stateSub.remove();
    powerSub.remove();
  };
}
