import json
import base64
import os

def create_notebook():
    with open('clipmaster-cloud.zip', 'rb') as f:
        b64_data = base64.b64encode(f.read()).decode('utf-8')

    code_script = f'''# @title 🚀 Click Play (▶) to Start ClipMaster 2.0 Cloud Engine
# @markdown Setup will take ~35-45 seconds. Keep this tab open while you use ClipMaster.
facebook_access_token = "" # @param {{type:"string"}}
# @markdown *(Optional) Paste your Meta / Facebook User Access Token above to auto-connect your Facebook Page & Instagram accounts.*

import os
import sys
import time
import base64
import zipfile
import subprocess
import re
from IPython.display import display, HTML, clear_output

print("⏳ [1/5] Setting up Node.js 20 & High-Performance Environment...")
subprocess.run("curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1", shell=True, check=True)

print("⏳ [2/5] Updating yt-dlp & Hindi/Unicode Subtitle Fonts...")
subprocess.run("pip install -q --upgrade yt-dlp", shell=True, check=True)
subprocess.run("apt-get update -qq && apt-get install -y -qq fonts-indic fonts-noto-core fonts-freefont-ttf fonts-dejavu-core fontconfig > /dev/null 2>&1", shell=True)
subprocess.run("fc-cache -f > /dev/null 2>&1", shell=True)

print("⏳ [3/5] Setting up Cloudflare Secure Tunnel...")
subprocess.run("curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared", shell=True, check=True)

print("⏳ [4/5] Extracting ClipMaster 2.0 App...")
app_dir = "/content/clipmaster"
os.makedirs(app_dir, exist_ok=True)
zip_path = "/content/clipmaster_bundle.zip"

b64_bundle = """{b64_data}"""
with open(zip_path, "wb") as f:
    f.write(base64.b64decode(b64_bundle))

with zipfile.ZipFile(zip_path, "r") as zip_ref:
    zip_ref.extractall(app_dir)

os.makedirs(f"{{app_dir}}/data/uploads", exist_ok=True)
os.makedirs(f"{{app_dir}}/data/exports/previews", exist_ok=True)
os.makedirs(f"{{app_dir}}/assets/bgm", exist_ok=True)

print("⏳ [5/5] Launching Server & Creating Mobile Link...")
subprocess.run("pkill -f 'node server.js' || true", shell=True)
subprocess.run("pkill -f 'cloudflared' || true", shell=True)
time.sleep(1)

# Pass token in environment if provided
node_env = os.environ.copy()
if facebook_access_token and facebook_access_token.strip():
    node_env["FB_ACCESS_TOKEN"] = facebook_access_token.strip()

server_proc = subprocess.Popen(["node", "server.js"], cwd=app_dir, env=node_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)

# Start Tunnel
tunnel_cmd = ["cloudflared", "tunnel", "--url", "http://127.0.0.1:4173"]
tunnel_proc = subprocess.Popen(tunnel_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

public_url = None
start_time = time.time()
while time.time() - start_time < 35:
    line = tunnel_proc.stderr.readline()
    if not line:
        time.sleep(0.2)
        continue
    match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
    if match:
        public_url = match.group(0)
        break

clear_output()

if public_url:
    display(HTML(f"""
    <div style="background: linear-gradient(135deg, #0d1117, #161b22); padding: 26px; border-radius: 16px; border: 2px solid #00ff88; box-shadow: 0 10px 30px rgba(0,255,136,0.18); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 650px; margin: 10px 0;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
        <span style="font-size: 34px;">🎬</span>
        <div>
          <h2 style="color: #00ff88; margin: 0; font-size: 22px; font-weight: 700;">ClipMaster 2.0 is LIVE!</h2>
          <p style="color: #8b949e; margin: 3px 0 0; font-size: 13px;">Google Cloud (12 GB RAM) · High-Speed Render Engine</p>
        </div>
      </div>
      
      <div style="background: rgba(0, 255, 136, 0.08); border: 1px dashed #00ff88; border-radius: 12px; padding: 16px; margin: 16px 0; text-align: center;">
        <p style="color: #c9d1d9; margin: 0 0 12px; font-size: 14px; font-weight: 500;">Click below to open ClipMaster on your Phone or Browser:</p>
        <a href="{{public_url}}" target="_blank" style="display: inline-block; background: #00ff88; color: #000; font-weight: 700; font-size: 16px; padding: 13px 32px; border-radius: 8px; text-decoration: none; box-shadow: 0 4px 16px rgba(0, 255, 136, 0.4); text-transform: uppercase; letter-spacing: 0.5px;">
          🚀 OPEN CLIPMASTER STUDIO
        </a>
      </div>

      <div style="color: #8b949e; font-size: 12px; line-height: 1.6;">
        <p style="margin: 4px 0;">📱 <b>Mobile Tip:</b> Open this link on your mobile phone browser (Chrome/Safari) and tap <b>'Add to Home Screen'</b> for 1-tap app access.</p>
        <p style="margin: 4px 0;">💡 <b>Note:</b> Keep this Google Colab tab open while you are using ClipMaster.</p>
      </div>
    </div>
    """))
    print(f"\\nDIRECT URL: {{public_url}}\\n")
else:
    print("❌ Tunnel connection timed out. Please run the cell again.")
'''

    notebook = {
        "nbformat": 4,
        "nbformat_minor": 0,
        "metadata": {
            "colab": {
                "name": "ClipMaster_Cloud.ipynb",
                "provenance": [],
                "collapsed_sections": []
            },
            "kernelspec": {
                "name": "python3",
                "display_name": "Python 3"
            },
            "language_info": {
                "name": "python"
            }
        },
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {
                    "id": "header_cell"
                },
                "source": [
                    "# 🎬 ClipMaster 2.0 · Free Google Cloud Engine\n",
                    "\n",
                    "Run **ClipMaster 2.0** on Google Cloud with **12 GB RAM + High-Speed FFmpeg & yt-dlp + Cloudflare Tunnel** for **₹0 Free Forever** (No Credit Card Needed).\n",
                    "\n",
                    "### 📱 Mobile Instructions:\n",
                    "1. Click the **Play button (▶)** on the code cell below.\n",
                    "2. Wait ~40 seconds for setup.\n",
                    "3. Click the green **OPEN CLIPMASTER STUDIO** link to start clipping videos and publishing to Facebook/Instagram directly from your phone!\n"
                ]
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {
                    "id": "run_cell",
                    "cellView": "form"
                },
                "outputs": [],
                "source": [code_script]
            }
        ]
    }

    with open("ClipMaster_Cloud.ipynb", "w", encoding="utf-8") as f:
        json.dump(notebook, f, indent=2)

    print("Successfully regenerated ClipMaster_Cloud.ipynb!")

if __name__ == '__main__':
    create_notebook()
