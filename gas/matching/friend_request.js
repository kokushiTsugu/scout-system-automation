/* =====================================================================
 *  Friend_Request – profile payload trimming + rate-limit retry
 *  v2025-07-15
 * ===================================================================== */

const SHEET_FR      = 'Friend_Request';
const COL_NOTE_FR   = 4, COL_STAT_FR = 5, COL_RAW_FR = 6;
const FR_BATCH_MAX  = 15;

const MATCH_URL     = 'https://match-service-650488873290.asia-northeast1.run.app/match?mode=scout';
const SA_EMAIL      = '650488873290-compute@developer.gserviceaccount.com';

const BYTE_LIMIT    = 30000;   // 30 KB 安全圏
const RETRY_MAX     = 3;       // rate-limit 時の再試行回数

/* ---- Friend Request メイン ---- */
function runFriendRequest() {
  const ui    = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_FR);
  if (!sheet) { ui.alert(`シート「${SHEET_FR}」が見つかりません`); return; }

  const rows = sheet.getDataRange().getValues();
  let done = 0;

  for (let i = 1; i < rows.length && done < FR_BATCH_MAX; i++) {
    if (rows[i][COL_STAT_FR - 1]) continue;           // 既に処理済み
    const R   = i + 1;
    const name= String(rows[i][0] || '').trim();
    const prof= String(rows[i][1] || '').trim();

    try {
      sheet.getRange(R, COL_STAT_FR).setValue('処理中…');

      /* 1) Match-API 取得 */
      const match = safeFetchMatch_(prof);
      const top2  = (match.selected_positions || []).slice(0, 2);
      if (!top2.length) throw new Error('適合求人が見つかりません');

      /* 2) Gemini で 300 字メッセージ */
      const note = callGemini_(buildFRPrompt_(name, top2));

      /* 3) シート書込 */
      sheet.getRange(R, COL_NOTE_FR).setValue(note);
      sheet.getRange(R, COL_RAW_FR ).setValue(JSON.stringify(match));
      sheet.getRange(R, COL_STAT_FR).setValue('処理完了');
    } catch (e) {
      sheet.getRange(R, COL_STAT_FR).setValue('エラー');
      sheet.getRange(R, COL_RAW_FR ).setValue(String(e).slice(0, 300));
      console.warn(`FriendRequest row ${R}:`, e);
    }
    done++;
  }
  ui.alert(`${done} 名を処理しました`);
}

/* ---- 安全 fetch (サイズ制限 + レートリミット再試行) ---- */
function safeFetchMatch_(profileTxt) {
  // ① 30 KB でバイト長カット
  let clean = profileTxt;
  while (Utilities.newBlob(clean).getBytes().length > BYTE_LIMIT) {
    clean = clean.slice(0, Math.floor(clean.length * 0.8));  // 20%ずつ削る
  }

  // ② 共通オプション
  const baseOpts = {
    method      : 'post',
    contentType : 'application/json',
    payload     : JSON.stringify({ candidate: { linkedin_profile: { text: clean } } })
  };

  // ③ リトライ付き呼び出し
  for (let i = 0; i < RETRY_MAX; i++) {
    const idTok = generateIdToken_(SA_EMAIL, MATCH_URL);
    try {
      return fetchMatchApi(MATCH_URL, { ...baseOpts, headers: { Authorization: `Bearer ${idTok}` } });
    } catch (e) {
      // rate-limit / 500 は再試行、他は即 throw
      if (i < RETRY_MAX - 1 && /rate limit|500/.test(e)) {
        Utilities.sleep(1500 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Match API failed after ${RETRY_MAX} retries`);
}

/* ---- SA で ID-Token 取得 ---- */
function generateIdToken_(saEmail, aud) {
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:generateIdToken`;
  const res = UrlFetchApp.fetch(url, {
    method      : 'post',
    contentType : 'application/json',
    payload     : JSON.stringify({ audience: aud, includeEmail: true }),
    headers     : { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }
  });
  return JSON.parse(res).token;
}

/* ---- Prompt Builder (変化なし) ---- */
function buildFRPrompt_(fullName, pos) {
  const last = fullName.split(/[\s　]/)[0] || '';
  const p1   = pos[0];
  const p2   = pos[1] || { title: '', salary: '' };

  return `
${last}様
【国内トップ層向け案件紹介】
ハイクラス向け人材紹介会社"TSUGU"代表の服部です。
これまでのご経歴を拝見し、ぜひご提案したい求人があり連絡いたしました！

―厳選求人例―
◆${p1.title}｜${p1.salary}
◆${p2.title}｜${p2.salary}

どちらも裁量大きく、事業成長を牽引できるポジションです。
※他100社以上の非公開求人案内可能

興味をお持ちいただけましたら、面談設定をお願いします！
${CALENDLY_URL}
`.trim();
}
