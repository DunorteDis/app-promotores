import { Platform } from 'react-native';
import type { MediaFile } from '@/services/media';

import { CameraSessionExpo } from './CameraSessionExpo';
import { CameraSessionVision } from './CameraSessionVision';

type Props = {
  visible: boolean;
  maxFotos: number;
  initialCount: number;
  onClose: (files: MediaFile[]) => void;
  onPhotoConfirmed?: (file: MediaFile) => void;
};

/**
 * Wrapper que escolhe a implementação certa por plataforma:
 *   iOS    → expo-camera (CameraSessionExpo) — bem testado, funciona perfeito
 *   Android → react-native-vision-camera (CameraSessionVision) — expõe 0.5x
 *              ultra-wide nativamente, que expo-camera no Android não consegue
 *              (clampa zoom em mínimo 1x).
 *
 * A `Props` externa é idêntica nos dois → quem chama (DunorteWebView) não muda.
 */
export function CameraSession(props: Props) {
  if (Platform.OS === 'android') {
    return <CameraSessionVision {...props} />;
  }
  return <CameraSessionExpo {...props} />;
}
