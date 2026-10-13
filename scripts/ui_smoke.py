"""界面冒烟测试：用 WebKit（和 Tauri 窗口同一引擎）模拟键盘建图，截图并收集报错。

用法：先 npx vite --port 1420，再 python3 scripts/ui_smoke.py <截图输出目录>
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp")
out.mkdir(parents=True, exist_ok=True)
errors: list[str] = []

with sync_playwright() as p:
    browser = p.webkit.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 760}, device_scale_factor=2)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    page.goto("http://localhost:1420")
    page.wait_for_selector(".welcome")
    page.screenshot(path=str(out / "1-welcome.png"))

    page.get_by_role("button", name="新建").click()
    page.wait_for_selector(".node.d0")

    def edit(text: str):
        page.wait_for_selector("textarea.editor")
        page.keyboard.press("Meta+a")
        page.keyboard.type(text)
        page.keyboard.press("Enter")

    # 根主题改名：空格进入编辑
    page.keyboard.press("Space")
    edit("年度产品规划")
    page.keyboard.press("Tab"); edit("目标")
    page.keyboard.press("Tab"); edit("营收增长 30%")
    page.keyboard.press("Enter"); edit("新客获取")
    page.keyboard.press("Enter"); edit("一个比较长的子主题标题，用来检查自动换行是否正常工作")
    page.keyboard.press("ArrowLeft")  # 回到「目标」
    page.keyboard.press("Enter"); edit("节奏")
    page.keyboard.press("Tab"); edit("Q1 调研")
    page.keyboard.press("Enter"); edit("Q2 上线")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Enter"); edit("风险")
    page.keyboard.press("Tab"); edit("供应链")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Enter"); edit("团队")

    titles = page.eval_on_selector_all(".node .label-text", "els => els.map(e => e.textContent)")
    page.screenshot(path=str(out / "2-map.png"))

    # 双击编辑
    box = page.locator(".node", has_text="供应链").first.bounding_box()
    page.mouse.dblclick(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    edit("供应链波动")

    # 折叠、撤销
    page.locator(".node", has_text="节奏").first.click()
    page.keyboard.press("Meta+/")
    folded = page.locator(".toggle.folded").count()
    page.keyboard.press("Meta+z")
    unfolded = page.locator(".toggle.folded").count()

    # 删除
    page.locator(".node", has_text="团队").first.click()
    page.keyboard.press("Backspace")
    has_team = page.locator(".node", has_text="团队").count()

    # 切到「向右」布局
    page.get_by_role("button", name="地图").click()
    page.screenshot(path=str(out / "3-right.png"))

    print("titles:", titles)
    print("folded after ⌘/:", folded, "after ⌘Z:", unfolded, "团队 after delete:", has_team)
    browser.close()

print("errors:", errors or "none")
