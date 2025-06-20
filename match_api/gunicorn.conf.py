# gunicorn.conf.py
workers   = 1                 # 1 vCPU なので固定 1
wsgi_app  = "main:app"        # ← これ必須!
bind      = "0.0.0.0:8080"    # Cloud Run デフォルトポート
timeout   = 120               # (任意) 60→120 秒に延長
# preload_app = True          # (任意) OOM 出なければ有効に
