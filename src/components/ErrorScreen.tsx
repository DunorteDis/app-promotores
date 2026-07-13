import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type Props = {
  visible: boolean;
  /** Código técnico do erro (ex.: net::ERR_INTERNET_DISCONNECTED) — ajuda o suporte. */
  detail?: string;
  onRetry: () => void;
};

/**
 * Tela amigável no lugar da página de erro crua do Chromium quando o WebView
 * falha em carregar (sem internet, DNS, servidor fora). Dá contexto pro
 * promotor e um botão de tentar de novo.
 */
export function ErrorScreen({ visible, detail, onRetry }: Props) {
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <Image
        source={require('../../assets/icon_transparent.png')}
        style={styles.logo}
        resizeMode="contain"
      />
      <Text style={styles.title}>Sem conexão</Text>
      <Text style={styles.text}>
        Não foi possível carregar o app. Verifique o Wi-Fi ou os dados móveis e tente de novo.
      </Text>
      <TouchableOpacity style={styles.button} onPress={onRetry} activeOpacity={0.8}>
        <Text style={styles.buttonText}>Tentar novamente</Text>
      </TouchableOpacity>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 12,
  },
  logo: { width: 96, height: 96, marginBottom: 4 },
  title: { color: '#0f172a', fontSize: 20, fontWeight: '700' },
  text: { color: '#334155', fontSize: 15, textAlign: 'center', lineHeight: 22 },
  button: {
    marginTop: 8,
    backgroundColor: '#0b5cff',
    paddingHorizontal: 28,
    height: 46,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  detail: { marginTop: 4, color: '#94a3b8', fontSize: 11 },
});
