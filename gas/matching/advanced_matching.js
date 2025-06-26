/* =====================================================================
 * 高度マッチング＆選考予測システム v2025-06-19.9
 * (このファイルは advanced_matching.gs です)
 * ---------------------------------------------------------------------
 * 変更点:
 * - 職種判定の際に、役職名だけでなく業務内容やスキル要件を総合的に解釈するようプロンプトを修正
 * ===================================================================== */

/* ===== 新機能用の固定値 ===== */
const SHEET_INTERVIEWS = 'Interview_Notes';
const SHEET_RESULTS    = 'Matching_Results';


/**
 * 高度マッチングのメイン処理 (変更なし)
 */
function runAdvancedMatching() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const interviewSheet = ss.getSheetByName(SHEET_INTERVIEWS);
  const resultSheet = ss.getSheetByName(SHEET_RESULTS);
  const jobSheet = ss.getSheetByName(SHEET_JOBS);

  const interviewData = interviewSheet.getDataRange().getValues();
  let targetRowIndex = -1;
  let candidateName, mustConditions, niceToHaveConditions, resumeText;
  for (let i = 1; i < interviewData.length; i++) {
    if (interviewData[i][6] === '') {
      targetRowIndex = i;
      candidateName = interviewData[i][0];
      mustConditions = interviewData[i][3];
      niceToHaveConditions = interviewData[i][4];
      resumeText = interviewData[i][5];
      break;
    }
  }
  if (targetRowIndex === -1) {
    ui.alert('処理対象の候補者が見つかりません。\nInterview_NotesシートのG列(Status)を空にしてください。');
    return;
  }
  const uiResponse = ui.alert(`「${candidateName}」さんの高度マッチングを開始しますか？`, ui.ButtonSet.YES_NO);
  if (uiResponse !== ui.Button.YES) return;

  try {
    interviewSheet.getRange(targetRowIndex + 1, 7).setValue('処理中…');

    const jobDataMap = new Map();
    const allJobsRaw = jobSheet.getDataRange().getValues().slice(1);
    
    allJobsRaw.forEach(r => {
      jobDataMap.set(r[0], { company: r[1], title: r[2], salary: r[6] });
    });

    // GASによる年収での事前フィルタリング
    let minSalaryCand = 0;
    const salaryMatch = mustConditions.match(/(?:年収|salary)\s*[:：]?\s*(\d+)/);
    if (salaryMatch) {
      minSalaryCand = parseInt(salaryMatch[1], 10);
    }
    
    const filteredJobs = allJobsRaw.filter(job => {
      const salaryStr = job[6];
      if (!salaryStr || minSalaryCand === 0) return true;
      const numbers = salaryStr.match(/\d+/g);
      if (!numbers) return true;
      const maxSalaryJob = Math.max(...numbers.map(n => parseInt(n, 10)));
      return maxSalaryJob >= minSalaryCand;
    });

    if (filteredJobs.length === 0) {
      throw new Error('年収のMust条件に合う求人が見つかりませんでした。');
    }
    
    const allJobsJson = JSON.stringify(
      filteredJobs.map(r => ({
        id: r[0], company: r[1], title: r[2], summary: r[4],
        location: r[5], salary: r[6], must: r[7], plus: r[8], person: r[9],
        appeal: r[10]
      })), null, 2
    );
    
    const prompt = buildAdvancedMatchingPrompt(candidateName, mustConditions, niceToHaveConditions, resumeText, allJobsJson);
    const aiText = callGemini(prompt);
    const resultData = JSON.parse(aiText);

    const outputRows = resultData.selected_positions.map(p => {
      const jobId = p.job_id;
      const jobInfo = jobDataMap.get(jobId) || { company: 'N/A', title: 'N/A', salary: 'N/A' };
      return [
        candidateName, p.rank, p.overall_score, p.candidate_fit_score, p.company_fit_score,
        jobId, jobInfo.company, jobInfo.title, jobInfo.salary,
        p.reason_for_company_fit, p.reason_for_candidate_fit
      ];
    });
    
    const lastRow = resultSheet.getLastRow();
    resultSheet.getRange(lastRow + 1, 1, outputRows.length, outputRows[0].length).setValues(outputRows);

    interviewSheet.getRange(targetRowIndex + 1, 7).setValue(`処理完了 (${new Date().toLocaleString()})`);
    ui.alert(`「${candidateName}」さんのマッチングが完了しました。\nMatching_Resultsシートを確認してください。`);

  } catch (err) {
    interviewSheet.getRange(targetRowIndex + 1, 7).setValue(`エラー: ${err.message}`);
    ui.alert(`エラーが発生しました: ${err.message}`);
  }
}

/**
 * 高度マッチング用のプロンプトビルダー（v7: 職種判定ロジック強化版）
 */
function buildAdvancedMatchingPrompt(candidateName, mustConditions, niceToHaveConditions, resumeText, allJobsJson) {
  return `
あなたは、日本トップクラスの採用戦略コンサルタントです。候補者と企業の双方の視点から、多角的にマッチングを評価するプロフェッショナルです。

# 厳守すべきルール
- **Must条件の絶対遵守**: 候補者の「Must（絶対条件）」を一つでも満たさない求人は、決して提案しないでください。
- **過去在籍企業の除外**: 候補者の職務経歴書に記載のある企業は、提案から必ず除外してください。
- **JSON出力**: 出力は有効なJSONのみとし、説明は一切不要です。

# あなたのタスク（2段階評価プロセス）
## ステップ1: Must条件による一次スクリーニング
まず、提供された「求人データベース」の中から、候補者の「Must（絶対条件）」を**全て満たす求人のみ**を絞り込みます。

★★★ 変更点 ★★★
**【重要】職種の判定方法:**
候補者のMust条件に「職種」の指定がある場合、求人票の\`title\`（役職名）だけで判断してはいけません。\`summary\`(業務内容), \`must\`(必須スキル), \`person\`(求める人物像) の内容を総合的に解釈し、**実質的にその職種に該当するか**を判断してください。例えば、役職名が「事業開発」でも、業務内容がマーケティング中心であれば「マーケティング職」と判断すべきです。

## ステップ2: 多角的評価によるランキング
次に、ステップ1で絞り込んだ求人の中から、後述の「評価のポイント」に基づき総合的に評価し、**Overall_Score**の高い順に**上位5件**を選定し、JSON形式で出力します。

# 評価のポイント
以下の3つの指標を、それぞれS, A, B, Cの4段階で評価してください。
- **Company_Fit_Score (企業側から見たマッチ度)**: 候補者の経験(Can)が、求人の必須スキル(must)・歓迎スキル(plus)にどれだけ合致しているか。**「選考通過可能性」**の指標です。
- **Candidate_Fit_Score (求職者希望度)**: 求人の内容が、候補者の希望条件（Nice to have）にどれだけ合致しているか。候補者が**「働きたい」と思えるか**の指標です。
- **Overall_Score (総合判断)**: 上記2つのスコアやキャリアプランとの整合性などを総合的に判断した、**最終的なおすすめ度**です。

### 評価理由（具体的なテキスト）
- **Reason_for_Company_Fit (企業側マッチ度の根拠)**: なぜそのCompany_Fit_Scoreなのか、候補者のどのスキル・経験が、求人のどの要件に合致しているかを具体的に記述します。
- **Reason_for_Candidate_Fit (求職者希望度の根拠)**: なぜそのCandidate_Fit_Scoreなのか、求人のどの点（業務内容、アピールポイント等）が、候補者のどの希望（Must, Nice to have）に合致しているかを具体的に記述します。

# JSONスキーマ
{
  "selected_positions": [
    {
      "rank": 1,
      "job_id": "",
      "overall_score": "S",
      "candidate_fit_score": "A",
      "company_fit_score": "S",
      "reason_for_company_fit": "",
      "reason_for_candidate_fit": ""
    }
  ]
}

# 候補者情報
## 候補者名: ${candidateName}
## Must（絶対条件）: ${mustConditions}
## Nice to have（希望条件）: ${niceToHaveConditions}
## 職務経歴書 (Can): ${resumeText}

# 求人データベース (JSON)
${allJobsJson}
`;
}