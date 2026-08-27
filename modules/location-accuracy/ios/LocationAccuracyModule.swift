import CoreLocation
import ExpoModulesCore

/**
 O `accuracyAuthorization` do CoreLocation — o dado que o expo-location NÃO
 expõe (ele entrega só o `scope`: whenInUse/always). É o equivalente iOS do
 `androidAccuracy: fine | coarse` que o Android já devolve, e sem ele a
 "Localização Exata" desligada só dava pra inferir pela accuracy travada em km.

 `requestTemporaryFullAccuracy` é o bônus que só existe do lado nativo: liga a
 precisão total num diálogo do sistema, sem mandar o promotor caçar menu nos
 Ajustes. Exige a chave `NSLocationTemporaryUsageDescriptionDictionary` no
 Info.plist (declarada no app.json) contendo a purposeKey passada aqui.
 */
public class LocationAccuracyModule: Module {
  /**
   Instância única e preguiçosa: um CLLocationManager criado dentro da função é
   liberado junto com ela, e aí o callback do diálogo de precisão nunca chega.
   Só é tocada dentro de `runOnQueue(.main)`, então a criação cai na main thread
   (que é onde o CLLocationManager quer nascer) sem corrida.
   */
  private lazy var manager = CLLocationManager()

  public func definition() -> ModuleDefinition {
    Name("LocationAccuracy")

    AsyncFunction("getAccuracyAuthorization") { () -> String in
      switch self.manager.accuracyAuthorization {
      case .fullAccuracy:
        return "full"
      case .reducedAccuracy:
        return "reduced"
      @unknown default:
        return "unknown"
      }
    }.runOnQueue(.main)

    AsyncFunction("requestTemporaryFullAccuracy") { (purposeKey: String, promise: Promise) in
      let manager = self.manager

      // Sem permissão de localização concedida o iOS engole o pedido em
      // silêncio — melhor falhar explícito do que o botão não fazer nada.
      guard manager.authorizationStatus == .authorizedWhenInUse
        || manager.authorizationStatus == .authorizedAlways
      else {
        promise.reject("ERR_SEM_PERMISSAO", "Localização não autorizada para este app.")
        return
      }

      if manager.accuracyAuthorization == .fullAccuracy {
        promise.resolve(true)
        return
      }

      manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: purposeKey) { error in
        if let error {
          promise.reject("ERR_PRECISAO_TOTAL", error.localizedDescription)
          return
        }
        // error == nil NÃO quer dizer "concedeu": o usuário pode ter recusado o
        // diálogo. Quem responde é o accuracyAuthorization depois dele.
        promise.resolve(manager.accuracyAuthorization == .fullAccuracy)
      }
    }.runOnQueue(.main)
  }
}
