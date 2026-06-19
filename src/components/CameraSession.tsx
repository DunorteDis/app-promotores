import type { MediaFile } from '@/services/media';

import { CameraSessionVision } from './CameraSessionVision';

type Props = {
  visible: boolean;
  maxFotos: number;
  initialCount: number;
  onClose: (files: MediaFile[]) => void;
  onPhotoConfirmed?: (file: MediaFile) => void;
};

/**
 * Tela de câmera multi-shot, em cima do react-native-vision-camera nas DUAS
 * plataformas (Android e iOS).
 *
 * Histórico: o iOS rodava no expo-camera (CameraSessionExpo) por ser bem
 * testado, mas o expo-camera 17 NÃO expõe foco por toque (tap-to-focus) no iOS
 * e o prop `autofocus` é invertido (`"on"` trava o foco após o primeiro foco).
 * Migramos o iOS pro vision-camera, que entrega autofoco CONTÍNUO por padrão +
 * foco real no ponto via `.focus({x,y})` (mesmo comportamento do Android). A
 * seleção de lente usa devices FÍSICOS (wide / ultra-wide), cujo neutralZoom é
 * 1 nas duas plataformas, então 0.5x / 1x / 2x funciona igual.
 *
 * `CameraSessionExpo.tsx` fica no repo como referência/fallback, mas não é mais
 * referenciado por nenhum caminho de execução.
 */
export function CameraSession(props: Props) {
  return <CameraSessionVision {...props} />;
}
