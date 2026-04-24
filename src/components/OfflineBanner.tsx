import { StyleSheet, Text, View } from 'react-native';

type Props = { visible: boolean };

export function OfflineBanner({ visible }: Props) {
  if (!visible) return null;
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Sem conexão com a internet. Algumas funções podem não funcionar.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#b91c1c',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '600',
  },
});
