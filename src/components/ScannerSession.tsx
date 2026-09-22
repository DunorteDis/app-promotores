import { useCallback, useEffect, useRef } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type ScanResult = { codigo: string | null; formato: string | null };

type Props = {
  visible: boolean;
  onClose: (result: ScanResult) => void;
};

/**
 * Sessão de leitura de código de barras (ponte: scanner.read), em cima do
 * `useCodeScanner` nativo do react-native-vision-camera@4 — a mesma lib já
 * usada em CameraSessionVision, sem lentes múltiplas: aqui só a back padrão.
 */
export function ScannerSession({ visible, onClose }: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const insets = useSafeAreaInsets();

  // Evita resolver duas vezes: onCodeScanned pode disparar várias vezes com o
  // mesmo código enquanto o Modal ainda está fechando.
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (visible) resolvedRef.current = false;
  }, [visible]);

  const codeScanner = useCodeScanner({
    codeTypes: ['ean-13', 'ean-8', 'upc-a', 'upc-e'],
    onCodeScanned: (codes) => {
      if (resolvedRef.current) return;
      const c = codes[0];
      if (c?.value) {
        resolvedRef.current = true;
        onClose({ codigo: c.value, formato: c.type });
      }
    },
  });

  const handleCancel = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onClose({ codigo: null, formato: null });
  }, [onClose]);

  useEffect(() => {
    if (visible && hasPermission === false) {
      void requestPermission();
    }
  }, [visible, hasPermission, requestPermission]);

  if (!visible) return null;

  if (hasPermission === false || !device) {
    return (
      <Modal visible animationType="slide" statusBarTranslucent transparent={false}>
        <View style={styles.permissionWrap}>
          <Text style={styles.permissionTitle}>Permissão de câmera</Text>
          <Text style={styles.permissionText}>
            Precisamos da câmera pra ler o código de barras.
          </Text>
          {hasPermission === false && (
            <TouchableOpacity style={styles.permissionBtn} onPress={() => void requestPermission()}>
              <Text style={styles.permissionBtnText}>Permitir</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.permissionBtn, styles.cancelBtn]} onPress={handleCancel}>
            <Text style={styles.permissionBtnText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible animationType="slide" statusBarTranslucent transparent={false}>
      <View style={styles.container}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={visible}
          codeScanner={codeScanner}
        />
        <View style={styles.frameHint} pointerEvents="none" />
        <View style={[styles.header, { paddingTop: Math.max(40, insets.top + 8) }]}>
          <TouchableOpacity style={styles.topBtn} onPress={handleCancel} hitSlop={8}>
            <Text style={styles.topBtnText}>✕  Cancelar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    paddingBottom: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  topBtn: { paddingVertical: 6, paddingRight: 8 },
  topBtnText: { color: '#fff', fontSize: 15, fontWeight: '500' },
  frameHint: {
    position: 'absolute',
    left: '12%',
    right: '12%',
    top: '40%',
    height: '20%',
    borderWidth: 2,
    borderColor: '#FACC15',
    borderRadius: 12,
  },
  permissionWrap: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  permissionTitle: { color: '#fff', fontSize: 22, fontWeight: '700' },
  permissionText: { color: '#ccc', fontSize: 15, textAlign: 'center', marginBottom: 8 },
  permissionBtn: {
    width: '100%',
    height: 48,
    borderRadius: 8,
    backgroundColor: '#1565C0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: { backgroundColor: 'rgba(255,255,255,0.15)' },
  permissionBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
