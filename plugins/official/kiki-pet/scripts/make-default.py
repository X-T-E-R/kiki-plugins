from pathlib import Path
import math, json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'lib' / 'assets' / 'momo'
OUT.mkdir(parents=True, exist_ok=True)
counts = [6, 8, 8, 4, 5, 8, 6, 6, 6]
atlas = Image.new('RGBA', (1536,1872))
ink = '#383b37'
for row, count in enumerate(counts):
    for frame in range(count):
        im = Image.new('RGBA',(192,208))
        d = ImageDraw.Draw(im)
        phase = frame / count * math.tau
        bob = round(math.sin(phase)*2)
        if row == 4: bob -= round(abs(math.sin(phase/2))*24)
        x, y = 96, 112 + bob
        if row in [1,2]: x += round(math.sin(phase)*3)
        gait = round(math.sin(phase)*9) if row in [1,2] else 0
        d.ellipse((x-47+gait,y+45,x-13+gait,y+63), fill='#d4a56c', outline=ink, width=3)
        d.ellipse((x+13-gait,y+45,x+47-gait,y+63), fill='#d4a56c', outline=ink, width=3)
        d.rounded_rectangle((x-53,y-57,x+53,y+52),radius=49,fill='#f5ead6',outline=ink,width=4)
        d.ellipse((x-42,y-15,x+42,y+39),fill='#e4d6bc')
        d.polygon([(x-25,y-54),(x-33,y-76),(x-10,y-59)],fill='#f5ead6',outline=ink,width=3)
        d.polygon([(x+25,y-54),(x+33,y-76),(x+10,y-59)],fill='#f5ead6',outline=ink,width=3)
        tilt = 2 if row == 8 else 0
        blink = row == 0 and frame == 2
        face_x = x + (15 if row == 1 else -15 if row == 2 else 0)
        eyes = [face_x-13,face_x+13] if row in [1,2] else [face_x-19,face_x+19]
        for ex in eyes:
            if blink: d.line((ex-5,y-25+tilt,ex+5,y-25+tilt),fill=ink,width=3)
            else: d.ellipse((ex-4,y-29+tilt,ex+4,y-19+tilt),fill=ink)
        d.ellipse((face_x-34,y-12,face_x-21,y-4),fill='#dfa6a0')
        d.ellipse((face_x+21,y-12,face_x+34,y-4),fill='#dfa6a0')
        d.polygon([(face_x-5,y-13),(face_x+5,y-13),(face_x,y-8)],fill=ink)
        if row == 5: d.arc((face_x-8,y-2,face_x+8,y+10),180,360,fill=ink,width=2)
        else: d.arc((face_x-10,y-12,face_x+10,y+4),0,180,fill=ink,width=2)
        paw = round(math.sin(phase)*8) if row in [1,2,3] else 0
        d.ellipse((x-63,y-3+pow(-1,frame)*paw,x-40,y+22+pow(-1,frame)*paw),fill='#f5ead6',outline=ink,width=3)
        right_y = y-37-paw if row == 3 else y-3-paw
        d.ellipse((x+40,right_y,x+63,right_y+25),fill='#f5ead6',outline=ink,width=3)
        if row == 5:
            d.line((x-25,y-35,x-13,y-31),fill=ink,width=3)
            d.line((x+13,y-31,x+25,y-35),fill=ink,width=3)
            d.ellipse((x+22,y-18,x+29,y-5),fill='#87b9bd')
        if row == 6:
            # Patient clock watching, not another idle animation.
            d.ellipse((x-14,y+10,x+14,y+38),fill='#b2c5b3',outline=ink,width=2)
            d.line((x,y+24,x,y+15),fill=ink,width=2)
            d.line((x,y+24,x+round(math.sin(phase)*9),y+24-round(math.cos(phase)*9)),fill=ink,width=2)
        if row == 7:
            d.rounded_rectangle((x-28,y+10,x+28,y+35),radius=6,fill='#b2c5b3',outline=ink,width=3)
            for dot in range(3):
                dy = round(math.sin(phase + dot*1.3)*3)
                d.ellipse((x-18+dot*14,y+21+dy,x-12+dot*14,y+27+dy),fill=ink)
        if row == 8:
            # Read across a page, turn it, then mark the final line.
            d.rounded_rectangle((x-27,y+4,x+27,y+42),radius=3,fill='#fff9ed',outline=ink,width=2)
            for line in range(3): d.line((x-18,y+13+line*8,x+17,y+13+line*8),fill='#9eaa99',width=2)
            scan_y = y+13+(frame%3)*8
            d.line((x-18,scan_y,x-18+(frame+1)*6,scan_y),fill=ink,width=2)
            if frame >= 3: d.polygon([(x+27,y+4),(x+27,y+18),(x+13,y+4)],fill='#b2c5b3',outline=ink)
            d.line((x+29,y+29,x+40,y+9-frame*2),fill='#d4a56c',width=4)
        atlas.alpha_composite(im,(frame*192,row*208))
atlas.save(OUT/'spritesheet.webp',lossless=True,exact=True)
manifest = {'id':'momo','displayName':'Momo','description':'A quiet little paper-and-ink companion. Original Kiki artwork.','spritesheetPath':'spritesheet.webp','author':'Kiki contributors','license':'CC0-1.0'}
(OUT/'pet.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'LICENSE.txt').write_text('Original artwork by Kiki contributors, dedicated to the public domain under CC0 1.0 Universal.\nhttps://creativecommons.org/publicdomain/zero/1.0/\n',encoding='utf-8')
icon=atlas.crop((0,0,192,208)).resize((128,128))
iconpath=ROOT/'runtime/src-tauri/icons/icon.png';iconpath.parent.mkdir(parents=True,exist_ok=True);icon.save(iconpath);icon.save(iconpath.with_suffix('.ico'),sizes=[(32,32),(64,64),(128,128)])
print(OUT)
