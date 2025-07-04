/* =====================================================================
 * スカウト自動化スクリプト v2025-06-19 (COO面談対応版)
 * ---------------------------------------------------------------------
 * 【主な変更点】
 * - 宛名を「姓」のみに自動抽出
 * - 紹介ポジションのフォーマットを目標スタイルに変更
 * - プロンプトを Few-shot 形式に刷新し、文章の質を向上
 * ===================================================================== */

/* ===== 1. 固定値 ===== */
const SHEET_JOBS   = 'Job_Database';
const SHEET_CANDS  = 'Candidate_Pipeline';
const MAX_BATCH    = 15;

/* ===== 3. メイン処理 (修正版) ===== */
function runBatchScoutMatching() {
  const ui        = SpreadsheetApp.getUi();
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const jobSheet  = ss.getSheetByName(SHEET_JOBS);
  const candSheet = ss.getSheetByName(SHEET_CANDS);

  /* 3-1. 募集中求人を JSON 配列化 */
  const jobJson = jobSheet.getDataRange().getValues()
    .slice(1)
    .filter(r => r[3] === '募集中')
    .map(r => ({
      id      : r[0],
      company : r[1],
      title   : r[2],
      salary  : r[6] || '応相談',
      summary : r[4],
      location: r[5],
      must    : r[7],
      plus    : r[8],
      person  : r[9],
      appeal  : r[10],
    }));

  if (!jobJson.length) {
    ui.alert('募集中求人がありません');
    return;
  }

  /* 3-2. 候補者ループ */
  const rows    = candSheet.getDataRange().getValues();
  let   handled = 0;

  for (let i = 1; i < rows.length && handled < MAX_BATCH; i++) {
    if (rows[i][2]) continue;
    const rowIdx = i + 1;
    try {
      candSheet.getRange(rowIdx, 3).setValue('処理中…');

      const fullName = rows[i][0];
      const profile  = rows[i][1];

      // ★ 姓名の間のスペースで分割し、姓を取得
      const lastName = fullName.split(/[\\s　]/)[0]; // ← 変数は残してOK

      const prompt  = buildPrompt('{姓}', profile, JSON.stringify(jobJson, null, 2));
      const aiText  = callGemini(prompt);
      const data    = JSON.parse(aiText);

      /* 3-3. 本文パーツ整形 & 生成 */

      // ❶ ポジションブロック
      const positionsForBody = data.positions
        .map(p => `◆ ${p.company_desc}
　${p.title}（年収 ${p.salary}）
${p.appeal_points.map(pt => `　${pt}`).join('\n')}`
        ).join('\n\n');

      // ❷ intro / closing 内の実名を {姓} へ強制置換
      const safeIntro   = data.intro_sentence.replaceAll(lastName, '{姓}');
      const safeClosing = data.closing_sentence.replaceAll(lastName, '{姓}');

      /* 3-4. 本文生成 (目標スタイルに変更) */
      const body =
`{姓} 様

はじめまして。ハイクラス転職支援の TSUGU ${YOUR_NAME}と申します。

${safeIntro}

▼ご紹介可能な案件例
────────────────────────
${positionsForBody}

${safeClosing}

ご興味ございましたら、弊社 COO ${COO_NAME} より 20〜30 分で
ポジション詳細と市場動向をご説明いたします。

▼下記リンクよりご都合の良い日時をお選びください
${CALENDLY_URL}

どうぞよろしくお願いいたします。
――――――――――――――
${YOUR_NAME} ｜${YOUR_COMPANY}`; // ← 署名のスペースを調整

      /* 3-5. シート反映 */
      const posListForSheet = data.positions
        .map(p => `${p.id} - ${p.title}`)
        .join('\n');

      candSheet.getRange(rowIdx, 4, 1, 4).setValues([[
        posListForSheet,
        data.subject,
        body,
        aiText
      ]]);

      candSheet.getRange(rowIdx, 3).setValue('処理完了');
    } catch (err) {
      candSheet.getRange(rowIdx, 3).setValue('エラー');
      candSheet.getRange(rowIdx, 7).setValue(String(err).slice(0, 500));
    }
    handled++;
  }
  ui.alert(`今回 ${handled} 名を処理しました。`);
}

/* ===== 4. プロンプトビルダー (改善版) ===== */
function buildPrompt(lastName, profile, jobListJson) {
  return `
あなたは、日本で活動する、超一流のハイクラス専門リクルーターです。
候補者の経歴を深く理解し、単なるポジション紹介ではなく「キャリアの新たな可能性を提示する、心を動かす一通」を作成してください。
最終的な出力は、後述の JSON スキーマに適合する **有効な JSON** のみです（コードフェンスや説明文は一切不要）。

# 厳守すべきルール
1. **呼称統一**: 候補者の呼称は必ず「{姓} 様」とする。
2. **過去所属企業の除外**: 候補者の過去在籍企業と同名の求人は必ず除外する。
3. **企業名の秘匿**: 本文・求人サマリーでは実社名を伏せ、代わりに魅力的な企業概要 (company_desc) を用いる。
4. **COO面談への誘導**: クロージングは必ず「弊社 COO ${COO_NAME} との 20〜30 分面談」へ繋げる。

# 作成ステップ
1. **候補者分析**: 経歴書から、候補者の専門性、具体的な実績、強みを深く理解する。
2. **求人選定**: 求人一覧の中から、候補者の経験とキャリア志向に最もマッチする求人を最大「2件」まで厳選する。
3. **JSON項目作成**: 以下の指示に従い、各項目を生成する。
    - **positions**:
        - 厳選した求人ごとに作成する。
        - **company_desc**: 「グローバル Commerce Media プラットフォーム」「国内リテールメディア立ち上げ企業」のように、事業内容が分かる魅力的な表現にする (25字以内)。
        - **title**: 求人の役職名をそのまま記載。
        - **salary**: 求人票の給与情報を記載。
        - **appeal_points**: 候補者の経歴に響くような訴求ポイントを「2点」抽出する。箇条書きの「・」を文頭に付ける。
    - **subject**: 「【限定スカウト】No.1求人のcompany_desc のポジションのご案内」という形式で作成する。
    - **intro_sentence**: 候補者の経歴から最も特筆すべき実績（在籍企業名＋具体的な役割）を引用し、「…してこられたご経歴に強く惹かれ、限定スカウトをお送りいたしました。」という自然で簡潔な一文を作成する。
    - **closing_sentence**: 「上記以外にも「広告×データ領域でのBizDev」「外資SaaSの日本ローンチ」など、{姓} 様のご志向に沿うポストを複数ご用意しています。」のように、紹介案件以外にも魅力的な選択肢があることを示唆する一文を作成する。

# お手本（このフォーマットとトーンを参考にしてください）
{
  "positions": [
    {
      "id": "JOB-001",
      "title": "シニアアカウントストラテジスト",
      "company_desc": "グローバル Commerce Media プラットフォーム",
      "salary": "800–1,100 万円",
      "appeal_points": [
        "・大手リテール＆ブランド向けにフルファネル施策を設計",
        "・CDP／データクリーンルーム連携など新機能導入を推進"
      ]
    },
    {
      "id": "JOB-002",
      "title": "アカウントディレクター",
      "company_desc": "国内リテールメディア立ち上げ企業",
      "salary": "750–1,000 万円",
      "appeal_points": [
        "・小売DX案件を起点に、広告在庫設計〜運用体制構築を統括",
        "・売上 KPI と広告体験の両立をリード"
      ]
    }
  ],
  "subject": "【限定スカウト】グローバル Commerce Media プラットフォームのポジションのご案内",
  "intro_sentence": "Criteo と楽天の双方でエンタープライズ広告主を担当され、リテール／ブランド横断の運用・分析・提案をリードしてこられたご経歴に強く惹かれ、限定スカウトをお送りいたしました。",
  "closing_sentence": "上記以外にも「広告×データ領域でのBizDev」「外資SaaSの日本ローンチ」など、{姓} 様のご志向に沿うポストを複数ご用意しています。"
}

# JSON スキーマ (この形式で出力してください)
{
  "positions": [
    {
      "id": "",
      "title": "",
      "company_desc": "",
      "salary": "",
      "appeal_points": []
    }
  ],
  "subject": "",
  "intro_sentence": "",
  "closing_sentence": ""
}

# 候補者情報
氏名: {姓} 様
PROFILE:
${profile}

# 求人一覧(JSON)
${jobListJson}
`;
}

/* ===== 5. Gemini 呼び出し (リトライ機能付き) ===== */
function callGemini(prompt) {
  const MAX_RETRIES = 3;    // 最大で3回まで試行する
  const RETRY_DELAY_MS = 5000; // 再試行までに5秒待つ

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const resp = UrlFetchApp.fetch(`${GEMINI_EP}?key=${GEMINI_KEY}`, {
        method : 'post',
        contentType : 'application/json',
        payload : JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4 }
        }),
        muteHttpExceptions: true,
      });

      // 503エラーの場合、少し待ってから再試行する
      if (resp.getResponseCode() === 503) {
        if (i < MAX_RETRIES - 1) { // 最後の試行でなければ
          console.log(`Gemini API 503エラー。${RETRY_DELAY_MS / 1000}秒後に再試行します... (${i + 1}/${MAX_RETRIES})`);
          Utilities.sleep(RETRY_DELAY_MS);
          continue; // ループの先頭に戻って再試行
        }
      }
      
      // 503以外のAPIエラー
      if (resp.getResponseCode() !== 200) {
        throw new Error(`Gemini API Error: ${resp.getResponseCode()} ${resp.getContentText()}`);
      }
      
      // 正常に成功した場合
      const j   = JSON.parse(resp.getContentText());
      let  out  = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!out) throw new Error('Gemini応答が空: ' + resp.getContentText().slice(0, 200));

      if (out.startsWith('```')) {
        out = out.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
      }
      return out; // ★ 成功したら、ここで結果を返して関数を終了

    } catch (e) {
      console.error(`callGeminiでエラー発生: ${e.message}`);
      if (i < MAX_RETRIES - 1) {
        Utilities.sleep(RETRY_DELAY_MS); // ネットワークエラーなどでも待機
      } else {
        throw e; // 最終的に失敗した場合はエラーをスローする
      }
    }
  }
}