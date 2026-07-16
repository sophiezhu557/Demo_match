# ABC 公益导师匹配系统 Demo

这是一个用于方案演示的导师匹配系统 Demo。前端为原生 HTML/CSS/JavaScript，后端为 Python 标准库 HTTP 服务，数据从 `input/mentors.csv` 和 `input/students.csv` 初始化到 SQLite。

## 本地运行

```bash
python server.py
```

然后打开：

```text
http://127.0.0.1:4173/
```

## 部署到 Render

1. 将本目录上传到 GitHub 仓库。
2. 在 Render 创建 Web Service，并连接该 GitHub 仓库。
3. 如果使用 `render.yaml`，Render 会自动读取以下配置：
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `python server.py`
   - `HOST=0.0.0.0`
4. 在 Render 的 Environment Variables 中设置：
   - `DEMO_ACCESS_CODE`: 演示访问码，用于保护 demo 页面和 API。

## 可选：持久化 SQLite 数据

默认情况下，云端数据库会由 CSV 初始化，适合短期演示。如果希望 Render 重启或重新部署后保留操作记录，可以在 Render 后台添加 Persistent Disk，并设置：

```text
DEMO_DB_PATH=/var/data/abc_mentor_demo.sqlite3
```

同时将 Persistent Disk 挂载到：

```text
/var/data
```

## 重要说明

这个项目是 Demo，不是正式生产系统。当前“登录”用于演示三种身份视角，并不是真实账号体系。正式上线前需要补充真实认证、权限控制、日志审计和数据备份。

