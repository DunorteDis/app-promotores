import * as FileSystem from 'expo-file-system/legacy';
import { Image as ImageCompressor } from 'react-native-compressor';

/**
 * ARMAZENAMENTO DA FOTO NO DISPOSITIVO — fora do navegador.
 *
 * Por que isto existe: até aqui a única casa durável da foto era o IndexedDB da
 * WebView, e é ele que está falhando em campo. Medido em 09/10/2026, no log de
 * produção: `"transação não commitou a tempo"` (10 casos) e `"Error preparing
 * Blob/File data to be stored in object store"` — falhas da máquina de
 * transação/blob do IndexedDB, não do aparelho. O plano B era o localStorage,
 * que para foto é pior ainda (5 MB no site inteiro, só texto, síncrono).
 *
 * Aqui a foto é ARQUIVO, no diretório privado do app, e **o sistema de arquivos
 * é o índice** — não há banco nenhum:
 *
 *   fotos/pendentes/<visita>__<questao>__<uuid>.jpg   aguardando confirmação
 *   fotos/enviadas/<visita>__<questao>__<uuid>.jpg    servidor já aceitou
 *
 * Listar é ler a pasta; confirmar é MOVER o arquivo (operação atômica do SO).
 * A escolha de não usar banco é deliberada: blob em banco significa que uma
 * corrupção leva TODAS as fotos junto, e no iOS o IndexedDB já é SQLite por
 * baixo — trocar de porta pro mesmo motor não consertaria nada.
 *
 * `documentDirectory` e não `cacheDirectory`: o sistema esvazia o cache sob
 * pressão de espaço, que é exatamente o momento em que a foto precisa existir.
 */

// PENDENTES em `documentDirectory`: é trabalho que ainda NÃO chegou ao
// servidor, então precisa sobreviver a tudo — inclusive à faxina do sistema
// sob pressão de espaço. No iOS isso entra no backup do iCloud, e aqui isso é
// DESEJÁVEL: celular perdido com 3 dias de fotos não enviadas, o backup salva.
const RAIZ = `${FileSystem.documentDirectory}fotos/`;
const PENDENTES = `${RAIZ}pendentes/`;

// ENVIADAS em `cacheDirectory`, de propósito: a foto JÁ está no servidor, então
// é cópia descartável. O sistema pode apagar quando quiser (não perdemos nada)
// e, no iOS, `Library/Caches` NÃO entra no backup do iCloud nem infla o
// "Documentos e dados" que o promotor vê na tela de armazenamento dele.
// Foi por isso que não escrevi plugin nativo pra excluir do backup: a pasta
// certa já tem a propriedade certa.
const ENVIADAS = `${FileSystem.cacheDirectory}fotos-enviadas/`;
/** Separador do nome: `__` porque id de visita/questão é numérico e nunca o contém. */
const SEP = '__';
/** Miniatura do preview. O arquivo cheio NUNCA volta pela ponte. */
const THUMB_LARGURA = 480;

// ── ESPAÇO NO APARELHO ────────────────────────────────────────────────────
// Medido no log de produção em 09/10: foto comprimida fica entre 363 KB e
// 526 KB (média ~440 KB). Uma visita com 20 fotos ocupa ~9 MB; um dia inteiro
// sem rede, com 10 visitas, ~90 MB — e some assim que o sync confirma.
//
// Ainda assim há aparelho lotado (iPhone de 64 GB com 300 fotos pessoais), e
// encher o celular do promotor é inaceitável: ele usa o aparelho pra vida
// dele, não só pro trabalho. Então há DOIS limites e os dois avisam alto em
// vez de falhar torto.

/**
 * Prazo das PENDENTES. Alto de propósito: enquanto o servidor não confirmou, a
 * foto é a única cópia e não tem validade — promotor pode passar dias sem rede.
 * Mas sem prazo nenhum elas se acumulam PARA SEMPRE: medido no aparelho em
 * 09/10, uma foto de check-in que o servidor recusou ficou órfã em `pendentes/`
 * e nada mais a reclamaria. Trinta dias é muito além de qualquer campo real.
 */
const DIAS_PENDENTE_ORFA = 30;

/**
 * Abaixo disto no aparelho, nem tenta: o sistema começa a se comportar mal.
 *
 * 50 MB, não 300. Uma foto comprimida tem ~400 KB e o pior caso (compressão
 * falhou, vai a original) ~8 MB — 50 MB ainda dão folga de várias capturas. O
 * piso alto virava REGRESSÃO: aparelho com 250 MB livres é rotina no parque de
 * campo, e ali o promotor deixava de fotografar por um limite nosso, numa
 * situação em que o caminho antigo (IndexedDB) fotografava sem reclamar.
 */
const PISO_LIVRE_BYTES = 50 * 1024 * 1024;
/** Teto da nossa pasta. ~1.100 fotos pendentes — muito além de um dia de campo. */
const TETO_PASTA_BYTES = 500 * 1024 * 1024;

export type FotoGuardada = {
  fotoId: string;
  visitaId: string;
  questaoId: string;
  enviada: boolean;
  bytes: number;
  /** ISO. Vem do mtime do arquivo; é o que a varredura usa pra decidir idade. */
  gravadaEm: string | null;
};

async function bytesDaPasta(dir: string): Promise<number> {
  const nomes = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
  let total = 0;
  for (const nome of nomes) {
    const info = await FileSystem.getInfoAsync(`${dir}${nome}`);
    if (info.exists && typeof info.size === 'number') total += info.size;
  }
  return total;
}

/**
 * Espaço livre do aparelho. Falhar a leitura NÃO pode impedir a foto: sem o
 * número, seguimos e deixamos a escrita decidir — negar por não saber seria
 * perder foto por precaução.
 */
async function livreNoAparelho(): Promise<number | null> {
  try {
    const n = await FileSystem.getFreeDiskStorageAsync();
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

async function garantirPastas(): Promise<void> {
  // ENVIADAS fica em outro volume lógico (cache), então entra na mesma lista:
  // `makeDirectoryAsync` com `intermediates` resolve os dois casos.
  for (const dir of [RAIZ, PENDENTES, ENVIADAS]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

function nomeDe(fotoId: string): string {
  return `${fotoId}.jpg`;
}

function uriPendente(fotoId: string): string {
  return `${PENDENTES}${nomeDe(fotoId)}`;
}

function uriEnviada(fotoId: string): string {
  return `${ENVIADAS}${nomeDe(fotoId)}`;
}

/**
 * Arquivo-irmão com a URL do S3 (`<id>.url`).
 *
 * Sem ele, o app reaberto não saberia que a foto JÁ subiu e mandaria de novo —
 * dados do promotor gastos à toa a cada reinício. Guardar isso num banco seria
 * recriar o problema que estamos fugindo; um arquivo de 100 bytes ao lado da
 * foto some junto com ela e não corrompe nada.
 */
function uriUrl(fotoId: string, enviada = false): string {
  return `${enviada ? ENVIADAS : PENDENTES}${fotoId}.url`;
}

async function lerUrlSalva(fotoId: string): Promise<string | null> {
  for (const uri of [uriUrl(fotoId), uriUrl(fotoId, true)]) {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) continue;
    const txt = await FileSystem.readAsStringAsync(uri).catch(() => '');
    if (txt.trim()) return txt.trim();
  }
  return null;
}

/** `<visita>__<questao>__<uuid>` — o próprio nome carrega os metadados. */
function montarId(visitaId: string, questaoId: string): string {
  const limpo = (v: string) => String(v ?? '').replace(/[^A-Za-z0-9-]/g, '') || '0';
  const uuid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${limpo(visitaId)}${SEP}${limpo(questaoId)}${SEP}${uuid}`;
}

function lerId(fotoId: string): { visitaId: string; questaoId: string } {
  const [visitaId = '0', questaoId = '0'] = fotoId.split(SEP);
  return { visitaId, questaoId };
}

/**
 * Grava a foto em `pendentes/` e devolve a miniatura pro preview.
 *
 * A gravação é em DOIS passos (arquivo temporário e depois mover): o app morto
 * no meio da escrita deixaria um arquivo truncado dentro de `pendentes/`, e o
 * upload mandaria lixo pro S3 como se fosse a foto do promotor.
 */
export async function guardarFoto(payload: {
  base64: string;
  visitaId?: string | number;
  questaoId?: string | number;
}): Promise<{ ok: true; fotoId: string; thumbBase64: string; bytes: number } | { ok: false; error: string }> {
  if (!payload?.base64) return { ok: false, error: 'base64 é obrigatório.' };
  try {
    await garantirPastas();

    // APERTOU O ESPAÇO: primeiro joga fora o que o servidor já confirmou — é
    // lixo nosso, e liberar isso resolve a maioria dos casos sem custo nenhum
    // pro promotor. Só depois disso é que se considera recusar.
    const livreAntes = await livreNoAparelho();
    const pastaAntes = await bytesDaPasta(PENDENTES);
    if ((livreAntes !== null && livreAntes < PISO_LIVRE_BYTES) || pastaAntes > TETO_PASTA_BYTES) {
      await limparFotos({ dias: 0 });
    }

    const livre = await livreNoAparelho();
    if (livre !== null && livre < PISO_LIVRE_BYTES) {
      return {
        ok: false,
        error: `Sem espaço no aparelho (${Math.round(livre / 1024 / 1024)} MB livres). Libere espaço — fotos, vídeos ou apps — para continuar fotografando.`,
      };
    }
    if ((await bytesDaPasta(PENDENTES)) > TETO_PASTA_BYTES) {
      return {
        ok: false,
        error: 'Muitas fotos aguardando envio neste aparelho. Conecte-se à internet para enviá-las antes de fotografar mais.',
      };
    }

    const fotoId = montarId(String(payload.visitaId ?? '0'), String(payload.questaoId ?? '0'));
    const destino = uriPendente(fotoId);
    const temporario = `${RAIZ}.tmp_${fotoId}.jpg`;

    try {
      await FileSystem.writeAsStringAsync(temporario, payload.base64, { encoding: 'base64' });
      await FileSystem.moveAsync({ from: temporario, to: destino });
    } catch (e) {
      // GRAVAR UM ARQUIVO LOCAL SÓ FALHA POR FALTA DE ESPAÇO, na prática. E essa
      // mensagem precisa ser esta, em português: é por ela que o lado web
      // reconhece o caso e PARA, em vez de tentar o caminho antigo — que usaria o
      // mesmo disco cheio e perderia a foto em silêncio.
      //
      // No iPhone esta é a ÚNICA defesa real: lá o piso de espaço livre nunca
      // dispara, porque a API do iOS reporta a capacidade "importante", que inclui
      // espaço purgável — num aparelho lotado ela ainda devolve gigabytes. O erro
      // nativo, além disso, vem em inglês e não seria reconhecido.
      await FileSystem.deleteAsync(temporario, { idempotent: true }).catch(() => {});
      const detalhe = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: `Sem espaço no aparelho para guardar a foto. Libere espaço — fotos, vídeos ou apps — e tente de novo. (${detalhe.slice(0, 80)})`,
      };
    }

    const info = await FileSystem.getInfoAsync(destino);
    const bytes = info.exists && typeof info.size === 'number' ? info.size : 0;
    // Arquivo de 0 byte = escrita que não valeu. Melhor falhar agora, com a
    // câmera ainda aberta, do que descobrir no envio.
    if (!bytes) {
      await FileSystem.deleteAsync(destino, { idempotent: true }).catch(() => {});
      return { ok: false, error: 'A foto foi gravada vazia no aparelho.' };
    }

    return { ok: true, fotoId, bytes, thumbBase64: await gerarThumb(destino) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Falha ao guardar a foto.' };
  }
}

/**
 * Miniatura para a tela. Falhar aqui NÃO pode derrubar a gravação: a foto já
 * está no disco, e preview feio é muito melhor que foto perdida.
 */
async function gerarThumb(uri: string): Promise<string> {
  try {
    const b64 = await ImageCompressor.compress(uri, {
      maxWidth: THUMB_LARGURA,
      quality: 0.5,
      returnableOutputType: 'base64',
    });
    return typeof b64 === 'string' ? b64 : '';
  } catch {
    return '';
  }
}

/** Miniatura de uma foto já guardada — usada pra reencontrar fotos de uma visita. */
export async function lerThumbFoto(payload: { fotoId: string }): Promise<
  { ok: true; thumbBase64: string } | { ok: false; error: string }
> {
  const fotoId = String(payload?.fotoId ?? '');
  if (!fotoId) return { ok: false, error: 'fotoId é obrigatório.' };
  for (const uri of [uriPendente(fotoId), uriEnviada(fotoId)]) {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) return { ok: true, thumbBase64: await gerarThumb(uri) };
  }
  return { ok: false, error: 'Foto não encontrada no aparelho.' };
}

/**
 * Sobe direto pro S3 — mesmo caminho provado pelo `recordVideo`: os bytes vão
 * do arquivo pra rede sem passar pelo JavaScript da WebView.
 */
export async function subirFoto(payload: {
  fotoId: string;
  uploadUrl: string;
  publicUrl?: string;
  contentType?: string;
}): Promise<{ ok: true; url: string | null; ausente?: boolean } | { ok: false; error: string }> {
  const fotoId = String(payload?.fotoId ?? '');
  if (!fotoId || !payload?.uploadUrl) return { ok: false, error: 'fotoId e uploadUrl são obrigatórios.' };
  // JÁ SUBIU numa sessão anterior: devolve a URL em vez de gastar os dados do
  // promotor mandando a mesma foto de novo.
  const jaSubiu = await lerUrlSalva(fotoId);
  if (jaSubiu) return { ok: true, url: jaSubiu };
  // Normalmente a foto está em `pendentes/`. Em `enviadas/` sem o `.url` ao lado
  // ela JÁ foi aceita uma vez e perdeu a marca — e aí o arquivo ainda serve: dar
  // `url: null` aqui fazia a web assumir a `publicUrl` nova, onde NADA foi
  // gravado, e o painel ficava com foto quebrada. Sobe de novo a partir de onde
  // o arquivo está.
  let uri = uriPendente(fotoId);
  if (!(await FileSystem.getInfoAsync(uri)).exists) {
    const enviada = uriEnviada(fotoId);
    if (!(await FileSystem.getInfoAsync(enviada)).exists) {
      // ARQUIVO SUMIU DE VERDADE (promotor removeu, varredura, limpeza do
      // sistema). Não é erro: erro faz a web tentar PARA SEMPRE e o item fica
      // preso na fila travando o check-out. `enviada: false` diz "não vai dar",
      // e o dreno segue sem a foto — com rastro do outro lado.
      return { ok: true, url: null, ausente: true };
    }
    uri = enviada;
  }
  try {
    const r = await FileSystem.uploadAsync(payload.uploadUrl, uri, {
      httpMethod: 'PUT',
      headers: { 'Content-Type': payload.contentType || 'image/jpeg' },
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      // FOREGROUND explícito: no iOS o padrão é sessão de FUNDO, que por desenho
      // ESPERA a conectividade em vez de falhar — sem rede a chamada simplesmente
      // não volta. Como o check-out só sai depois que a fila esvazia, a visita
      // ficava presa atrás de um upload que nunca ia nem falhar. No Android o
      // mesmo uploadAsync rejeita em menos de um segundo, e é por isso que o
      // teste no aparelho Android não tinha como ver este caso.
      sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    });
    if (r.status < 200 || r.status >= 300) return { ok: false, error: `Falha no upload (HTTP ${r.status}).` };
    const url = String(payload.publicUrl ?? '').trim();
    // Gravar a marca NÃO pode derrubar um upload que deu certo: na pior das
    // hipóteses a foto sobe de novo na próxima vez.
    if (url) await FileSystem.writeAsStringAsync(uriUrl(fotoId), url).catch(() => {});
    return { ok: true, url: url || null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Falha no upload da foto.' };
  }
}

/**
 * Move de `pendentes/` para `enviadas/`.
 *
 * Só pode ser chamado quando o SERVIDOR aceitou a pesquisa contendo aquela URL
 * — não quando o upload terminou, e muito menos no fim da visita. Upload
 * concluído com a pesquisa ainda na fila é exatamente o estado em que apagar a
 * foto significa perdê-la.
 */
export async function confirmarFoto(payload: { fotoId: string }): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const fotoId = String(payload?.fotoId ?? '');
  if (!fotoId) return { ok: false, error: 'fotoId é obrigatório.' };
  try {
    await garantirPastas();
    const origem = uriPendente(fotoId);
    const info = await FileSystem.getInfoAsync(origem);
    if (!info.exists) return { ok: true }; // já confirmada
    await FileSystem.moveAsync({ from: origem, to: uriEnviada(fotoId) });
    const marca = await FileSystem.getInfoAsync(uriUrl(fotoId));
    if (marca.exists) {
      await FileSystem.moveAsync({ from: uriUrl(fotoId), to: uriUrl(fotoId, true) }).catch(() => {});
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Falha ao confirmar a foto.' };
  }
}

/**
 * O que ainda está no aparelho. É isto que permite a tela REENCONTRAR as fotos
 * de uma visita mesmo quando o rascunho se perde — o sintoma relatado em campo
 * ("marquei SIM, a resposta voltou e a foto sumiu").
 */
export async function listarFotos(payload?: { visitaId?: string | number; incluirEnviadas?: boolean }): Promise<{
  ok: true;
  fotos: FotoGuardada[];
}> {
  await garantirPastas();
  const alvo = payload?.visitaId != null ? String(payload.visitaId) : null;
  const fotos: FotoGuardada[] = [];

  for (const [dir, enviada] of [[PENDENTES, false], [ENVIADAS, true]] as const) {
    if (enviada && !payload?.incluirEnviadas) continue;
    const nomes = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
    for (const nome of nomes) {
      if (!nome.endsWith('.jpg')) continue; // os `.url` são metadados, não fotos
      const fotoId = nome.slice(0, -4);
      const { visitaId, questaoId } = lerId(fotoId);
      if (alvo && visitaId !== alvo) continue;
      const info = await FileSystem.getInfoAsync(`${dir}${nome}`);
      fotos.push({
        fotoId,
        visitaId,
        questaoId,
        enviada,
        bytes: info.exists && typeof info.size === 'number' ? info.size : 0,
        gravadaEm:
          info.exists && typeof info.modificationTime === 'number'
            ? new Date(info.modificationTime * 1000).toISOString()
            : null,
      });
    }
  }
  return { ok: true, fotos };
}

/**
 * Varredura das CONFIRMADAS antigas. Mexe só em `enviadas/`: o que está em
 * `pendentes/` não tem prazo de validade — enquanto o servidor não confirmou, a
 * foto fica, mesmo que o promotor passe dias sem rede.
 */
export async function limparFotos(payload?: {
  dias?: number;
  referenciados?: string[];
}): Promise<{ ok: true; apagadas: number }> {
  await garantirPastas();
  // Ids que o front declarou VIVOS (na fila, em rascunho ou em correção).
  // Sem esta lista a varredura decide sozinha quem é órfã olhando só o mtime — e
  // o mtime MENTE: aparelho com relógio atrasado na hora da gravação e corrigido
  // depois faz uma foto de HOJE parecer de 30 dias atrás, e ela ia embora com o
  // item ainda na fila. É a mesma lição do `limparBackupsDeUpload` no
  // IndexedDB: quem sabe o que ainda é referenciado é a fila, não o disco.
  // `undefined` e `[]` são coisas DIFERENTES: array vazio é "consultei a fila e
  // ela está vazia"; ausente é "não consegui consultar". No segundo caso a
  // varredura de pendentes nem roda — preferir acúmulo a apagar foto viva, já
  // que o caso em que a lista não vem é o IndexedDB doente, a falha que originou
  // tudo isto.
  const consultouFila = Array.isArray(payload?.referenciados);
  const preservar = new Set(
    (consultouFila ? payload!.referenciados! : []).map((v) => String(v)),
  );
  // `dias: 0` = varredura agressiva, usada quando o espaço apertou: tudo que o
  // servidor confirmou pode sair AGORA. O normal (7 dias) existe só pra dar
  // margem a uma investigação depois de um incidente.
  const dias = payload?.dias === 0 ? 0 : Math.max(1, Number(payload?.dias) || 7);
  const limite = Date.now() - dias * 24 * 60 * 60 * 1000;
  let apagadas = 0;

  const nomes = await FileSystem.readDirectoryAsync(ENVIADAS).catch(() => [] as string[]);
  for (const nome of nomes) {
    const uri = `${ENVIADAS}${nome}`;
    const info = await FileSystem.getInfoAsync(uri);
    const quando = info.exists && typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0;
    if (quando && quando < limite) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      apagadas++;
    }
  }
  // PENDENTES ÓRFÃS: passaram do prazo sem nunca subir. Ou a pesquisa que as
  // referenciava morreu, ou o envio foi recusado em definitivo — de todo jeito
  // ninguém mais vai buscá-las, e sem isto elas ocupam o teto da pasta para
  // sempre, impedindo o promotor de fotografar.
  const limiteOrfa = Date.now() - DIAS_PENDENTE_ORFA * 24 * 60 * 60 * 1000;
  const pendentes = consultouFila
    ? await FileSystem.readDirectoryAsync(PENDENTES).catch(() => [] as string[])
    : [];
  for (const nome of pendentes) {
    // O `.url` é irmão da foto e precisa sobreviver junto com ela: apagar só o
    // `.url` deixaria o item re-subindo bytes que já estão no S3.
    if (preservar.has(nome.replace(/\.(jpg|url)$/, ''))) continue;
    const uri = `${PENDENTES}${nome}`;
    const info = await FileSystem.getInfoAsync(uri);
    const quando = info.exists && typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0;
    if (quando && quando < limiteOrfa) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      apagadas++;
    }
  }

  // Temporários de uma escrita interrompida — mas SÓ os abandonados. Apagar todo
  // `.tmp_` que aparece matava o arquivo de uma captura EM VOO (a gravação é
  // temp → move), e a varredura do boot roda concorrendo com a câmera. Sem idade
  // legível não apaga: um órfão de 50 KB custa menos que uma foto perdida.
  const limiteTmp = Date.now() - 60 * 60 * 1000;
  const soltos = await FileSystem.readDirectoryAsync(RAIZ).catch(() => [] as string[]);
  for (const nome of soltos) {
    if (!nome.startsWith('.tmp_')) continue;
    const uri = `${RAIZ}${nome}`;
    const info = await FileSystem.getInfoAsync(uri);
    const quando = info.exists && typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0;
    if (!quando || quando > limiteTmp) continue;
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    apagadas++;
  }
  return { ok: true, apagadas };
}

/** Descarte explícito (promotor removeu a foto da pesquisa antes de enviar). */
export async function apagarFoto(payload: { fotoId: string }): Promise<{ ok: true }> {
  const fotoId = String(payload?.fotoId ?? '');
  if (fotoId) {
    for (const uri of [uriPendente(fotoId), uriEnviada(fotoId), uriUrl(fotoId), uriUrl(fotoId, true)]) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }
  return { ok: true };
}
