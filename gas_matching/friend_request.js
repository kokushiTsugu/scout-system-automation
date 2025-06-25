/* =====================================================================
 *  LinkedIn 300-char Connection-Note Generator – Friend_Request
 *  v2025-06-25  (Cloud Run ID-Token 認証版)
 * ===================================================================== */

const SHEET_FR      = 'Friend_Request';
const COL_NOTE_FR   = 4, COL_STAT_FR = 5, COL_RAW_FR = 6;
const FR_BATCH_MAX  = 15;

const MATCH_URL   = 'https://match-service-650488873290.asia-northeast1.run.app/match?mode=scout';
const SA_EMAIL    = '650488873290-compute@developer.gserviceaccount.com';

/* ---- Friend Request メイン ---- */
function runFriendRequest() {
  const ui    = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_FR);
  if (!sheet) { ui.alert(`シート「${SHEET_FR}」が見つかりません`); return; }

  const rows = sheet.getDataRange().getValues();
  let done = 0;

  for (let i = 1; i < rows.length && done < FR_BATCH_MAX; i++) {
    if (rows[i][COL_STAT_FR - 1]) continue;
    const R   = i + 1;
    const name= String(rows[i][0]||'').trim();
    const prof= String(rows[i][1]||'').trim();

    try {
      sheet.getRange(R, COL_STAT_FR).setValue('処理中…');

      /* 1) Match-API (上位 2 件) */
      const match = fetchMatch_(prof);
      const top2  = (match.selected_positions||[]).slice(0,2);
      if (!top2.length) throw new Error('適合求人が見つかりません');

      /* 2) Gemini で 300 字メッセージ */
      const note = callGemini_(buildFRPrompt_(name, top2));

      /* 3) シート書込 */
      sheet.getRange(R, COL_NOTE_FR).setValue(note);
      sheet.getRange(R, COL_RAW_FR ).setValue(JSON.stringify(match));
      sheet.getRange(R, COL_STAT_FR).setValue('処理完了');
    } catch (e) {
      sheet.getRange(R, COL_STAT_FR).setValue('エラー');
      sheet.getRange(R, COL_RAW_FR ).setValue(String(e).slice(0,300));
    }
    done++;
  }
  ui.alert(`${done} 名を処理しました`);
}

/* ---- Cloud Run 呼び出し ---- */
function fetchMatch_(profileTxt) {
  const idTok = generateIdToken_(SA_EMAIL, MATCH_URL);
  const resp  = UrlFetchApp.fetch(MATCH_URL, {
    method:'post',contentType:'application/json',
    headers:{Authorization:`Bearer ${idTok}`},
    payload:JSON.stringify({candidate:{linkedin_profile:{text:profileTxt}}}),
    muteHttpExceptions:true
  });
  if (resp.getResponseCode()!==200){
    throw new Error(`Match API ${resp.getResponseCode()}: ${resp.getContentText().slice(0,120)}`);
  }
  return JSON.parse(resp);
}

/* ---- SA で ID-Token 取得 ---- */
function generateIdToken_(saEmail, aud){
  const url=`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:generateIdToken`;
  const res=UrlFetchApp.fetch(url,{
    method:'post',contentType:'application/json',
    payload:JSON.stringify({audience:aud,includeEmail:true}),
    headers:{Authorization:`Bearer ${ScriptApp.getOAuthToken()}`}
  });
  return JSON.parse(res).token;
}

/* ---- Prompt Builder (改訂版) ---- */
function buildFRPrompt_(fullName, pos) {
  const last = fullName.split(/[\s　]/)[0] || '';
  const p1   = pos[0];
  const p2   = pos[1] || { title: '', salary: '' };

  return `
あなたは日本語ネイティブのハイクラスリクルーター。
下記テンプレを埋め、**全角換算300文字以内** のプレーンテキストを 1 回だけ出力せよ。
装飾・コードフェンスは禁止。

制約:
* 1 行目は「${last}様」
* 「御社／貴社」「過度な誇張表現」は使用禁止
* 求人は厳選 2 件
テンプレ:
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

