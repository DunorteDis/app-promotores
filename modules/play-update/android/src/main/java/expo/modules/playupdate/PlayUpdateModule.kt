package expo.modules.playupdate

import android.app.Activity
import android.content.Context
import android.os.Build
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 Atualização pela própria Google Play (In-App Updates): o modal nativo da loja
 aparece por cima do app, em vez de mandar o promotor pra página do Vexo.

 Só vale para quem instalou PELA Play. O APK distribuído por fora é assinado com
 outra chave e a Play não tem como atualizá-lo — ali `verificar` devolve null e
 a web segue o fluxo antigo, do link.

 Usa `startUpdateFlow` (devolve uma Task com o resultado) e não o
 `startUpdateFlowForResult`: assim não precisa mexer no onActivityResult da
 MainActivity, que é gerada pelo prebuild.
 */
class PlayUpdateModule : Module() {
  private val contexto: Context
    get() = requireNotNull(appContext.reactContext) { "sem contexto Android" }

  private val manager: AppUpdateManager by lazy { AppUpdateManagerFactory.create(contexto) }

  // O download do modo flexível corre no processo da Play; isto avisa o JS
  // quando terminou, pra perguntar se reinicia.
  private val ouvinte = InstallStateUpdatedListener { estado ->
    if (estado.installStatus() == InstallStatus.DOWNLOADED) sendEvent("onBaixada")
  }
  private var ouvindo = false

  override fun definition() = ModuleDefinition {
    Name("PlayUpdate")
    Events("onBaixada")

    OnCreate {
      if (instaladoPelaPlay()) {
        manager.registerListener(ouvinte)
        ouvindo = true
      }
    }

    OnDestroy {
      if (ouvindo) manager.unregisterListener(ouvinte)
    }

    AsyncFunction("verificar") { promise: Promise ->
      if (!instaladoPelaPlay()) {
        promise.resolve(null)
        return@AsyncFunction
      }
      manager.appUpdateInfo
        .addOnSuccessListener { info ->
          promise.resolve(
            mapOf(
              "disponivel" to temAtualizacao(info),
              "versionCode" to info.availableVersionCode(),
            )
          )
        }
        // Play desatualizada, sem conta Google etc.: tratar como "não veio da
        // Play" faz a web cair no link, que é o que já funcionava.
        .addOnFailureListener { promise.resolve(null) }
    }

    AsyncFunction("iniciar") { tipo: String, promise: Promise ->
      manager.appUpdateInfo
        .addOnSuccessListener { info -> iniciarCom(info, tipo == "imediato", promise) }
        .addOnFailureListener { promise.resolve("falhou") }
    }

    AsyncFunction("concluir") { promise: Promise ->
      manager.completeUpdate()
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e -> promise.reject("ERR_PLAY_CONCLUIR", e.message, e) }
    }
  }

  private fun iniciarCom(info: AppUpdateInfo, imediato: Boolean, promise: Promise) {
    when (info.installStatus()) {
      // Flexível aceito antes e já baixado: só falta instalar. No bloqueio
      // instala direto; na sugestão quem pergunta é o JS.
      InstallStatus.DOWNLOADED -> {
        if (imediato) manager.completeUpdate()
        promise.resolve("baixada")
        return
      }
      // Download flexível em andamento: abrir o modal de novo só confundiria.
      InstallStatus.PENDING, InstallStatus.DOWNLOADING -> if (!imediato) {
        promise.resolve("baixando")
        return
      }
    }

    val opcoes = AppUpdateOptions.defaultOptions(
      if (imediato) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
    )
    val atividade = appContext.currentActivity
    if (!temAtualizacao(info) || !info.isUpdateTypeAllowed(opcoes) || atividade == null) {
      promise.resolve("indisponivel")
      return
    }

    manager.startUpdateFlow(info, atividade, opcoes)
      .addOnSuccessListener { codigo ->
        promise.resolve(
          when (codigo) {
            Activity.RESULT_OK -> "aceita"
            Activity.RESULT_CANCELED -> "recusada"
            else -> "falhou" // ActivityResult.RESULT_IN_APP_UPDATE_FAILED
          }
        )
      }
      .addOnFailureListener { promise.resolve("falhou") }
  }

  // DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS = imediato que a pessoa largou no
  // meio (saiu do app durante o download); chamar de novo retoma a tela da Play.
  private fun temAtualizacao(info: AppUpdateInfo) =
    info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE ||
      info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS ||
      info.installStatus() == InstallStatus.DOWNLOADED

  private fun instaladoPelaPlay(): Boolean = runCatching {
    val pm = contexto.packageManager
    val instalador = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      pm.getInstallSourceInfo(contexto.packageName).installingPackageName
    } else {
      @Suppress("DEPRECATION")
      pm.getInstallerPackageName(contexto.packageName)
    }
    instalador == "com.android.vending"
  }.getOrDefault(false)
}
