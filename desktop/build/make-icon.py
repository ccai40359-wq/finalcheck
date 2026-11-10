# 把 logo 裁到内容边界并铺满画布（任务栏/窗口/exe 图标用满版，不留白边）
# 用法：python build/make-icon.py   （在 desktop/ 下执行）
from PIL import Image
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'icon.png')

im = Image.open(SRC).convert('RGBA')
alpha = im.split()[-1]
bbox = alpha.getbbox()
if not bbox:
    raise SystemExit('icon.png 没有可见内容')
cropped = im.crop(bbox)

# 正方形画布（内容居中，不拉伸），再缩到 512 铺满
side = max(cropped.size)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(cropped, ((side - cropped.width) // 2, (side - cropped.height) // 2))
full = canvas.resize((512, 512), Image.LANCZOS)

full.save(SRC)
full.save(os.path.join(HERE, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon: crop', cropped.size, '-> 512x512 full bleed; ico written')
