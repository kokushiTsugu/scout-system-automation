/* =====================================================================
 *  Friend_Request – v2025-07-15 REV-B
 *   • payload 上限対策 (22 KB)
 *   • Gemini プロンプトを明確化（改善点禁止・一方向）
 * ===================================================================== */

const SHEET_FR      = 'Friend_Request';
const COL_NOTE_FR   = 4, COL_STAT_FR = 5, COL_RAW_FR = 6;
const FR_BATCH_MAX  = 15;

const MATCH_URL     = 'https://match-service-650488873290.asia-northeast1.run.app/match?mode=scout';
const SA_EMAIL      = '650488873290-compute@developer.gserviceaccount.com';

const BYTE_LIMIT    = 22000;    // 22 KB なら JSON 包含でも安全
const RETRY_MAX     = 3;

/* ---- メイン ---- */
function runFriendRequest() {
  const ui    = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_FR);
  if (!sheet) { ui.alert(`シート「${SHEET_FR}」が見つかりません`); return; }

  const rows = sheet.getDataRange().getValues();
  let done = 0;

  for (let i = 1; i < rows.length && done < FR_BATCH_MAX; i++) {
    if (rows[i][COL_STAT_FR - 1]) continue;
    const R    = i + 1;
    const name = String(rows[i][0] || '').trim();     // フルネーム
    const prof = String(rows[i][1] || '').trim();

    try {
      sheet.getRange(R, COL_STAT_FR).setValue('処理中…');

      /* 1) Match */
      const match = safeFetchMatch_(prof);
      const top2  = (match.selected_positions || []).slice(0, 2);
      if (!top2.length) throw new Error('適合求人なし');

      /* 2) Gemini */
      const note = callGemini_(buildFRPrompt_(name, top2));

      /* 3) 書込 */
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

/* ---- サイズ制限 + リトライ ---- */
function safeFetchMatch_(profileTxt) {
  let txt = profileTxt;
  while (Utilities.newBlob(txt).getBytes().length > BYTE_LIMIT) {
    txt = txt.slice(0, Math.floor(txt.length * 0.8));
  }

  const base = {
    method:'post',
    contentType:'application/json',
    payload:JSON.stringify({candidate:{linkedin_profile:{text:txt}}})
  };

  for (let i=0;i<RETRY_MAX;i++){
    const idTok = generateIdToken_(SA_EMAIL, MATCH_URL);
    try {
      return fetchMatchApi(MATCH_URL, {...base, headers:{Authorization:`Bearer ${idTok}`}});
    } catch (e){
      if(i<RETRY_MAX-1 && (/rate limit|500/.test(e))) { Utilities.sleep(1500*(i+1)); continue; }
      throw e;
    }
  }
  throw new Error('Match API 再試行上限');
}

/* ---- ID-Token ---- */
function generateIdToken_(sa, aud){
  const url=`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateIdToken`;
  const res=UrlFetchApp.fetch(url,{
    method:'post',contentType:'application/json',
    payload:JSON.stringify({audience:aud,includeEmail:true}),
    headers:{Authorization:`Bearer ${ScriptApp.getOAuthToken()}`}
  });
  return JSON.parse(res).token;
}

/* ---- Gemini Prompt (改善版 v2) ---- */
function buildFRPrompt_(fullName, pos) {
  // 名字（姓）を抽出するロジック
  const lastName = fullName.split(/[\s　]/)[0] || fullName;
  
  // ★★★ 変更点(1): company_desc も取得する ★★★
  const positionsData = pos.map(p => ({
    desc: p.company_desc || '', // 会社概要
    title: p.title || 'N/A',      // 役職名
    salary: p.salary || ''       // 給与
  }));

  const p1 = positionsData[0];
  const p2 = positionsData[1];
  
  const calendlyUrl = 'https://calendly.com/k-nagase-tsugu/30min';

  return `
あなたは、指定されたフォーマットとルールを100%完璧に遵守する、プロのメッセージ作成アシスタントです。
あなたの唯一のタスクは、以下の構成要素とフォーマット見本を使い、一つの完成されたメッセージテキストのみを出力することです。

# 厳守すべきルール
- **フォーマットの完全遵守**: 後述する「# 完成形フォーマット」を寸分違わず再現してください。改行の位置も同じです。
- **文字数制限**: 全体の文字数を必ず300文字以内に収めてください。
- **編集の禁止**: 提供された固定テキスト（自己紹介文など）を一切変更しないでください。
- **出力**: 完成したメッセージ本文のみを出力し、説明や言い訳、コードフェンス(\`\`\`)は絶対に含めないでください。

# 構成要素
- **候補者の姓**: ${lastName}
- **求人1**: ${p1.desc} ${p1.title}｜${p1.salary}
- **求人2**: ${p2 ? `${p2.desc} ${p2.title}｜${p2.salary}` : ''}
- **面談リンク**: ${calendlyUrl}

# 完成形フォーマット (この形式を厳守)

${lastName}様
【国内トップ層向け案件紹介】
ハイクラス向け人材紹介会社"TSUGU"代表の服部です。${lastName}様のこれまでのご経歴を拝見し、ぜひご紹介したい求人がございます。

―厳選求人例―
◆${p1.desc} ${p1.title}｜${p1.salary}
◆${p2 ? `${p2.desc} ${p2.title}｜${p2.salary}` : ''}

いずれも裁量大きく、事業成長を牽引できるポジションです。他にも100社以上の非公開求人を扱っております。

ご興味があれば、面談をお願いいたします。
${calendlyUrl}
`.trim();
}