/* =====================================================================
 *  共通ユーティリティ ＋ メニュー生成  (v2025-06-25)
 * ===================================================================== */

/* ==== 共通定数 ==== */
const CALENDLY_URL = 'https://calendly.com/k-nagase-tsugu/_linked-in-in-mail';
const YOUR_NAME    = '服部';
const YOUR_COMPANY = 'TSUGU';
const COO_NAME     = '長瀬';

const GEMINI_KEY = PropertiesService.getScriptProperties()
                   .getProperty('GEMINI_API_KEY');
const GEMINI_EP  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';

/* ==== 共通 Gemini 呼び出し ==== */
function callGemini_(prompt, temperature = 0.4) {
  const resp = UrlFetchApp.fetch(`${GEMINI_EP}?key=${GEMINI_KEY}`, {
    method : 'post',
    contentType : 'application/json',
    payload : JSON.stringify({
      contents:[{ parts:[{ text: prompt }] }],
      generationConfig:{ temperature }
    }),
    muteHttpExceptions:true
  });
  if (resp.getResponseCode()!==200) {
    throw new Error(`Gemini API ${resp.getResponseCode()}: ${resp.getContentText().slice(0,150)}`);
  }
  let txt = JSON.parse(resp).candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!txt) throw new Error('Gemini 応答が空です');
  if (txt.startsWith('```')) txt = txt.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  return txt;
}

/* ==== メニューはここで一元管理 ==== */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('スカウト補助')
    .addItem('InMail',            'runBatchScoutMatching')   // InMail
    .addItem('Friend_Request', 'runFriendRequest')       // 300 文字
    .addItem('インタビュー後マッチング',               'runAdvancedMatching')    // 高度マッチング
    .addToUi();
}
