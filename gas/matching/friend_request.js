/* =====================================================================
 * Friend_Request - v2025-10-04 (Server-Generated Note / Fast Fetch, Name-aware)
 * 役割：シート「Friend_Request」を上から順に処理し、
 *       Cloud Run(/match?mode=scout) の結果を貼り付けるだけに簡素化。
 *       文面はサーバが生成（friend_request_note）。無い場合のみローカル整形。
 * ===================================================================== */

// ---- 固定値 ----
const SHEET_FR_ONLY     = 'Friend_Request'; // A:氏名 / B:プロフィール（テキスト or URL）/ C:未使用 / D:Note / E:Status / F:Raw
const COL_NOTE_FR_ONLY  = 4; // D列
const COL_STAT_FR_ONLY  = 5; // E列
const COL_RAW_FR_ONLY   = 6; // F列

// バッチは保守的に（GASの実行上限対策）
const FR_BATCH_MAX_ONLY = 10;

// Cloud Run（未認証公開）直叩き（Bearer不要）
const MATCH_URL_FR_ONLY = 'https://match-api-650488873290.asia-northeast1.run.app/match?mode=scout';

// Cloud Run payloadのサイズ目安（32KB未満に）
const BYTE_LIMIT_FR_ONLY = 32000;

// 軽いネットワーク用の最小リトライ
const RETRY_MAX_FR_ONLY  = 1;


/* ==== メイン処理 ==== */
function runFriendRequest() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_FR_ONLY);
  if (!sheet) { ui.alert(`シート「${SHEET_FR_ONLY}」が見つかりません`); return; }

  const T0 = Date.now();  // 5分ガード
  const rows = sheet.getDataRange().getValues();
  let done = 0;

  for (let i = 1; i < rows.length && done < FR_BATCH_MAX_ONLY; i++) {
    if (Date.now() - T0 > 5 * 60 * 1000) break; // 5分超で中断
    if (rows[i][COL_STAT_FR_ONLY - 1]) continue;

    const R    = i + 1;
    const name = String(rows[i][0] || '').trim(); // A:氏名（空なら空文字）
    const prof = String(rows[i][1] || '').trim(); // B:プロフィール（テキスト or URL）

    try {
      sheet.getRange(R, COL_STAT_FR_ONLY).setValue('処理中…');

      // 1) Cloud Run へ（氏名も送る）
      const match = safeFetchMatch_FR_FAST_(name, prof);

      // 2) 2件の選定が無ければエラー
      const top2 = (match.selected_positions || []).slice(0, 2);
      if (!top2.length) throw new Error('適合求人なし');

      // 3) サーバ生成noteを優先。無ければローカル整形（同じ正規化ロジック）
      const serverNote = (match.friend_request_note || '').trim();
      const note = serverNote || buildFRNoteLocal_FR_(name, top2);

      // 4) シートへ書き戻し
      sheet.getRange(R, COL_NOTE_FR_ONLY).setValue(note);
      sheet.getRange(R, COL_RAW_FR_ONLY).setValue(JSON.stringify(match));
      sheet.getRange(R, COL_STAT_FR_ONLY).setValue('処理完了');
    } catch (e) {
      sheet.getRange(R, COL_STAT_FR_ONLY).setValue('エラー');
      sheet.getRange(R, COL_RAW_FR_ONLY).setValue(String(e).slice(0, 300));
      console.warn(`FriendRequest row ${R}:`, e);
    }
    done++;
  }

  ui.alert(`${done} 名を処理しました`);
}


/* ==== ローカル整形（サーバnoteが無い時の最終フォールバック） ==== */
function buildFRNoteLocal_FR_(fullName, pos) {
  // 姓（あるいは末尾トークン）を安全抽出。空なら敬称を付けない。
  const nameStr  = String(fullName || '').trim();
  const lastName = nameStr ? (nameStr.split(/[\s　]/).pop() || nameStr) : '';

  const p1 = pos[0] || {};
  const p2 = pos[1] || null;

  const line1 = formatJobLineLocal_(p1);
  const line2 = p2 ? formatJobLineLocal_(p2) : '';
  const jobsBlock = [line1, line2].filter(l => l.trim()).join('\n');

  const calendlyUrl = 'https://calendly.com/k-nagase-tsugu/_linked-in-fr';

  // URLが切れないように：本文部を先に作り、URL分の文字数を確保してからトリム
  const headName = lastName ? `${lastName}様` : ''; // 空なら敬称なし
  const prefix =
`${headName}
【国内トップ層向け案件紹介】
ハイクラス向け人材紹介会社"TSUGU"代表の服部です。ご経歴を拝見し、ぜひご紹介したい求人がございます。
―厳選求人例―
${jobsBlock}
ご興味あれば、面談をお願いいたします。
`.replace(/^\n/, ''); // 先頭改行除去

  const MAX = 300;
  const url = calendlyUrl;
  const roomForBody = MAX - (url.length + 1);

  let body = prefix;
  if (body.length > roomForBody) {
    body = body.slice(0, Math.max(0, roomForBody - 1)) + '…';
  }
  // 末尾URLは必ずフルで残す
  return `${body}\n${url}`;
}

// 役割名抽出・給与正規化（GAS側フォールバック用・サーバと同等の簡易規則）
function formatJobLineLocal_(job) {
  const title = String(job.title || '');
  const summary = String(job.summary || '');
  const role = deriveRoleLocal_(title, summary);       // 役割名（オブラート）
  const salary = normalizeSalaryLocal_(String(job.salary || '')); // 例：650–850万円
  const safeRole = role || 'コアメンバー';
  return `◆${safeRole}｜${salary}`;
}

function normalizeSalaryLocal_(s) {
  if (!s) return '';
  let t = s.replace(/\s+/g, '').replace(/,/g, '');
  t = t.replace(/~/g, '–').replace(/-/g, '–');
  return t;
}

function softTitleLocal_(t) {
  if (!t) return '';
  let x = t;
  x = x.replace(/【.*?】/g, '');
  x = x.replace(/[（(].*?[)）]/g, '');
  x = x.replace(/新規事業/g, '');
  x = x.replace(/\s+/g, ' ').replace(/^[\s\-｜|]+|[\s\-｜|]+$/g, '');
  // 代表的な短縮
  x = x.replace(/テクニカルプロダクトマネージャー/g, 'テクニカルPdM');
  return x.trim();
}

// タイトル/サマリから“伝わる役割名”を抽出（優先順マッチ）
function deriveRoleLocal_(title, summary) {
  const hay = `${title} ${summary}`;
  const rules = [
    [/インサイド.?セールス|Inside\s*Sales|IS\b/i, 'インサイドセールス'],
    [/テクニカル.?PdM|プロダクトマネージャ|PdM\b/i, 'テクニカルPdM'],
    [/プロダクト.?マネージャ|Product\s*Manager/i, 'PdM'],
    [/事業開発|Biz\s*Dev|BD\b/i, '事業開発'],
    [/カスタマー.?サクセス|Customer\s*Success|CS\b/i, 'カスタマーサクセス'],
    [/マーケティング|Marketing|Growth/i, 'マーケティング'],
    [/セールス|営業/i, 'セールス'],
    [/ソフトウェア|SWE|エンジニア|バックエンド|フロントエンド|フルスタック/i, 'ソフトウェアエンジニア'],
    [/データサイエンティスト|Data\s*Scientist/i, 'データサイエンティスト'],
    [/プロジェクトマネージャ|PM\b/i, 'プロジェクトマネージャ'],
    [/プロダクトオーナー|PO\b/i, 'プロダクトオーナー'],
  ];
  for (const [re, lab] of rules) if (re.test(hay)) return lab;
  const soft = softTitleLocal_(title);
  if (soft) return soft;
  return '';
}


/* ==== Cloud Run 呼び出し（Bearerなし・軽量版） ==== */
function safeFetchMatch_FR_FAST_(fullName, profileTxt) {
  // ① payload を32KB未満に（テキストが長い時は縮小）
  const wrap = (nm, t) => JSON.stringify({
    candidate: { name: String(nm || ''), linkedin_profile: { text: t } }
  });
  let txt = String(profileTxt || '');
  while (Utilities.newBlob(wrap(fullName, txt)).getBytes().length > BYTE_LIMIT_FR_ONLY) {
    txt = txt.slice(0, Math.floor(txt.length * 0.6));  // 40%カット
  }

  // ② 共通オプション（Cloud Runは未認証公開：Bearer不要）
  const base = {
    method: 'post',
    contentType: 'application/json',
    payload: wrap(fullName, txt),
    muteHttpExceptions: true,
  };

  // ③ 最小リトライ（瞬断/500のみ）
  let lastErr = null;
  for (let i = 0; i < RETRY_MAX_FR_ONLY; i++) {
    try {
      const res = UrlFetchApp.fetch(MATCH_URL_FR_ONLY, base);
      const code = res.getResponseCode();
      if (code >= 400) throw new Error(`Match API ${code}: ${res.getContentText().slice(0, 180)}`);
      return JSON.parse(res.getContentText());
    } catch (e) {
      lastErr = e;
      if (i < RETRY_MAX_FR_ONLY - 1 && /(?:^|[^a-z])(500|rate limit)/i.test(String(e))) {
        Utilities.sleep(1500 * (i + 1));
        continue;
      }
      break;
    }
  }
  throw lastErr || new Error('Match API 失敗');
}
