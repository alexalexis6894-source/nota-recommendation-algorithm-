"""Нормализация фото флаконов Фрагрантики в единые плитки 3:4 для макетов НОТЫ.
process.py RAW_DIR CUT_DIR OUT_DIR"""
import sys, os, glob
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

RAW, CUT, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
CW, CH = 600, 800                     # плитка 3:4, хватает на 3x ретину при ширине ~200px
BOX_W, BOX_H, FLOOR = .80, .80, .92   # поле для флакона и линия «пола»
LIGHT = (236, 233, 227)               # тёплый светлый, близко к фону НОТЫ
DARK = (28, 29, 31)

def trim_white(im, thr=242):
    a = np.asarray(im.convert("RGB")).min(axis=2)
    ys, xs = np.where(a < thr)
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

def trim_alpha(im, thr=10):
    a = np.asarray(im)[:, :, 3]
    ys, xs = np.where(a > thr)
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

AREA = (.78 * CH) * (.39 * CH)        # одна «визуальная масса» на все флаконы

def fit(im):
    # равняем по площади, чтобы широкие и узкие флаконы смотрелись одного веса, но не вылезали из поля
    s = min((AREA / (im.width * im.height)) ** .5, CW * BOX_W / im.width, CH * BOX_H / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS), s

def bg(color, glow):
    base = Image.new("RGB", (CW, CH), color)
    if glow:
        g = Image.new("L", (CW, CH), 0)
        ImageDraw.Draw(g).ellipse((-CW*.2, -CH*.15, CW*1.2, CH*.85), fill=255)
        g = g.filter(ImageFilter.GaussianBlur(120))
        lit = Image.new("RGB", (CW, CH), tuple(min(255, c + glow) for c in color))
        base = Image.composite(lit, base, g)
    return base

def shadow(canvas, x, w, y, strength):
    sh = Image.new("L", (CW, CH), 0)
    ImageDraw.Draw(sh).ellipse((x + w*.08, y - 10, x + w*.92, y + 12), fill=strength)
    sh = sh.filter(ImageFilter.GaussianBlur(9))
    canvas.paste(Image.new("RGB", (CW, CH), (0, 0, 0)), (0, 0), sh)

def best_raw(pid):
    best = None
    for v in ("o", "375x500"):
        f = os.path.join(RAW, f"{pid}.{v}.jpg")
        if not os.path.exists(f): continue
        t = trim_white(Image.open(f).convert("RGB"))
        if best is None or t.height > best[1].height: best = (v, t)
    return best

ids = sorted({os.path.basename(f).split(".")[0] for f in glob.glob(os.path.join(RAW, "*.jpg"))})
for pid in ids:
    # 1. как есть: каталожный кадр 375x500 на белом
    Image.open(os.path.join(RAW, f"{pid}.375x500.jpg")).convert("RGB").resize((CW, CH), Image.LANCZOS).save(f"{OUT}/{pid}.asis.jpg", quality=88)

    # 2. растворение: обрезаем поля, ставим на пол, белый фон смешиваем с цветом плитки (multiply)
    v, t = best_raw(pid)
    b, s = fit(t)
    x, y = (CW - b.width) // 2, round(CH * FLOOR) - b.height
    a = np.asarray(b).astype(np.float32)
    m = a.min(axis=2, keepdims=True)
    a = np.where(m > 236, a + (255 - a) * np.clip((m - 236) / 14, 0, 1), a)   # почти белое доводим до белого
    canvas = np.asarray(bg(LIGHT, 0)).astype(np.float32)
    region = canvas[y:y+b.height, x:x+b.width]
    canvas[y:y+b.height, x:x+b.width] = region * a / 255
    Image.fromarray(canvas.astype(np.uint8)).save(f"{OUT}/{pid}.blend.jpg", quality=88)
    print(pid, "src", v, t.size, "scale %.2f" % s)

    # 3-4. вырезка: прозрачный флакон, своя общая тень, светлая и тёмная плитка
    cf = os.path.join(CUT, f"{pid}.{v}.png")
    if not os.path.exists(cf): continue
    c = trim_alpha(Image.open(cf).convert("RGBA"))
    cb, _ = fit(c)
    x, y = (CW - cb.width) // 2, round(CH * FLOOR) - cb.height
    for name, col, glow, sh in (("cut", LIGHT, 10, 70), ("dark", DARK, 22, 150)):
        cv = bg(col, glow)
        shadow(cv, x, cb.width, y + cb.height, sh)
        cv.paste(cb, (x, y), cb)
        cv.save(f"{OUT}/{pid}.{name}.jpg", quality=88)
