# match.py
import os, json, functools, base64
from flask import Flask, request, jsonify
from googleapiclient.discovery import build
import google.auth, google.generativeai as genai
import numpy as np

SPREADSHEET_ID = os.environ['SPREADSHEET_ID']
SCOPES  = ['https://www.googleapis.com/auth/spreadsheets.readonly']
creds,_ = google.auth.default(scopes=SCOPES)
sheets  = build('sheets','v4',credentials=creds)

genai.configure(api_key=os.environ['GEMINI_API_KEY'])
flash = genai.GenerativeModel('gemini-1.5-flash')
pro   = genai.GenerativeModel('gemini-1.5-pro')

app = Flask(__name__)

# ---------- util ----------
@functools.lru_cache
def load_jobs():
    vals = sheets.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range='Job_Database!A:K').execute().get('values',[])
    return [dict(id=r[0], company=r[1], title=r[2], status=r[3],
                 summary=r[4], loc=r[5], salary=r[6]) for r in vals[1:] if r[3]=='募集中']

def embed(txt:str)->np.ndarray:
    # Flash embedding endpoint（text-embedding-004）を想定
    vec = genai.embed_content(model='models/embedding-001', content=txt)['embedding']
    return np.array(vec)

def strip_fence(txt:str)->str:
    if txt.startswith('```'): txt = txt.split('\n',1)[1].rsplit('```',1)[0]
    return txt.strip()

# ---------- main endpoint ----------
@app.route('/match', methods=['POST'])
def match():
    mode = request.args.get('mode','scout')
    body = request.get_json()
    if not body or 'candidate' not in body:
        return jsonify(error='candidate required'),400
    cand = body['candidate']
    
    if mode=='scout':
        result = scout_flow(cand)
    elif mode=='proposal':
        result = proposal_flow(cand)
    else:
        return jsonify(error='mode must be scout|proposal'),400
    
    return jsonify(result)

# ---------- flows ----------
def scout_flow(cand):
    jobs = load_jobs()
    # —— 1. embedding similarity
    c_vec = embed(json.dumps(cand.get('linkedin_profile','')))
    sims  = [(j,np.dot(c_vec, embed(j['summary']))) for j in jobs]
    top20 = sorted(sims,key=lambda x:-x[1])[:20]
    # —— 2. Gemini Flash pick & heuristics
    prompt = f"""
    下記候補者 LinkedIn と求人20件から、最もクリック率が高そうな2件だけ JSONで返して。
    ただしキーは id,title,company_desc,salary の4項目のみ。
    ### CAND
    {cand['linkedin_profile']}
    ### JOBS
    {json.dumps([j for j,_ in top20],ensure_ascii=False)}
    """
    txt = strip_fence(flash.generate_content(prompt).text)
    pos = json.loads(txt)['selected_positions'][:2]
    click = int(50 + 50*np.tanh(sum(s for _,s in top20[:2])))  # 雑なヒューリスティック
    return {'selected_positions':pos,'click_score':click}

def proposal_flow(cand):
    jobs = load_jobs()
    must = cand.get('must','')
    nice = cand.get('nice','')
    # —— step1 salary filter（雑に年収レンジ上限 >= must 年収）
    filtered = jobs
    if must.isdigit():
        filtered = [j for j in jobs if j['salary'] and int(must)<=int(j['salary'][:4])]
    filtered = filtered[:50]

    # —— step2 Flash quick filter
    flash_p = f"""
    候補者履歴書と求人リスト。must条件を満たさない求人は除外し、20件以内に絞ってID配列を返せ
    ### MUST
    {must}
    ### CAND
    {cand['resume'][:1500]}
    ### JOBS
    {json.dumps(filtered, ensure_ascii=False)}
    """
    keep_ids = json.loads(strip_fence(flash.generate_content(flash_p).text))
    subset   = [j for j in filtered if j['id'] in keep_ids][:20]

    # —— step3 Pro scoring
    pro_p = f"""
    候補者要約と求人を読み、overall,candidate_fit,company_fit を100点満点で付与し JSON配列返却。
    ### CAND
    {cand['resume'][:2000]}
    ### JOBS
    {json.dumps(subset, ensure_ascii=False)}
    """
    scored = json.loads(strip_fence(pro.generate_content(pro_p).text))
    scored = sorted(scored,key=lambda x:-x['overall_score'])[:5]
    return {'selected_positions':scored}

# ---------- local debug ----------
if __name__=='__main__':
    app.run('0.0.0.0',port=8080,debug=True)
