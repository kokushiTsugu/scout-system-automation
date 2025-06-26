//【JSONインポーター 最終確定版：自動クリア機能付き】

function importJsonToJobDatabase() {
  const ui = SpreadsheetApp.getUi();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const importerSheet = spreadsheet.getSheetByName('JSON_Importer');
  const jobDbSheet = spreadsheet.getSheetByName('Job_Database');

  // --- 1. 入力チェック ---
  if (!importerSheet || !jobDbSheet) {
    ui.alert('エラー：「JSON_Importer」または「Job_Database」シートが見つかりません。');
    return;
  }
  const jsonString = importerSheet.getRange('A2').getValue();
  if (jsonString === '') {
    ui.alert('JSONが入力されていません。A2セルに貼り付けてください。');
    return;
  }

  // --- 2. 登録処理の実行 ---
  try {
    const data = JSON.parse(jsonString);

    // ★★★ 重複チェックのロジック ★★★
    const jobDbData = jobDbSheet.getDataRange().getValues();
    let isDuplicate = false;
    for (let i = 1; i < jobDbData.length; i++) {
      const existingCompany = jobDbData[i][1]; 
      const existingPosition = jobDbData[i][2];
      if (data.company_name === existingCompany && data.position_name === existingPosition) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      ui.alert('エラー：このポジションは既にデータベースに登録されています。\n\n会社名：' + data.company_name + '\nポジション名：' + data.position_name);
      return; // returnの前にfinallyが実行される
    }
    
    // --- 3. 新規登録処理 ---
    const lastRow = jobDbSheet.getLastRow();
    const newRow = lastRow + 1;

    const rowData = [
      data.job_id || newRow - 1,
      data.company_name || '',
      data.position_name || '',
      data.status || '募集中',
      data.job_summary || '',
      data.work_location || '',
      data.salary_range || '',
      Array.isArray(data.required_skills) ? data.required_skills.join('\n') : (data.required_skills || ''),
      Array.isArray(data.preferred_skills) ? data.preferred_skills.join('\n') : (data.preferred_skills || ''),
      data.ideal_candidate_profile || '',
      Array.isArray(data.appeal_points) ? data.appeal_points.join('\n') : (data.appeal_points || '')
    ];
    
    jobDbSheet.getRange(newRow, 1, 1, rowData.length).setValues([rowData]);
    SpreadsheetApp.flush();
    ui.alert(`求人情報「${data.position_name || ''}」の登録が完了しました。（${newRow}行目）`);

  } catch (e) {
    // JSONの形式不正や、その他の予期せぬエラー
    ui.alert('処理エラー', '処理中にエラーが発生しました。\n\n詳細: ' + e.toString(), ui.ButtonSet.OK);
  
  } finally {
    // ★★★★★ ここが追加された部分です ★★★★★
    // 処理が成功しても、重複エラーで中断しても、その他のエラーが発生しても、
    // どんな状況でも「最後に必ず」この処理が実行されます。
    importerSheet.getRange('A2').clearContent();
  }
}