import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

type Props = { visible: boolean };

export function LoadingOverlay({ visible }: Props) {
  if (!visible) return null;
  return (
    <View style={styles.overlay} pointerEvents="none">
      <ActivityIndicator size="large" color="#0b5cff" />
      <Text style={styles.text}>Carregando...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  text: {
    color: '#334155',
    fontSize: 14,
    fontWeight: '600',
  },
});
