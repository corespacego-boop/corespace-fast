from bs4 import BeautifulSoup
from datetime import datetime

class CalendarService:
    @staticmethod
    def parse_calendar(html_content):
        cal = []
        day_order = "-"
        if not html_content: 
            return cal, day_order
        
        soup = BeautifulSoup(html_content, 'lxml')
        now = datetime.now()
        current_day_num = str(now.day)
        current_month_label = now.strftime("%b '%y")  
        
        # 1. Academia Style Table Parsing
        tbl = None
        for t in soup.find_all('table'):
            if "Dt" in t.get_text():
                tbl = t
                break
        
        if tbl:
            rows = tbl.find_all('tr')
            month_block_index = -1
            header_cells = rows[0].find_all(['td', 'th']) if rows else []
            
            block_count = 0
            for cell in header_cells:
                cell_text = cell.get_text(strip=True)
                if current_month_label in cell_text:
                    month_block_index = block_count
                    break
                block_count += 1

            for r in rows:
                cells = r.find_all('td')
                if not cells: continue
                
                for block_idx in range(len(cells) // 4):
                    start_i = block_idx * 4
                    dt_txt = cells[start_i].get_text(strip=True)
                    if not dt_txt.isdigit():
                        continue
                        
                    day_val = cells[start_i + 1].get_text(strip=True) if start_i + 1 < len(cells) else ""
                    desc_val = cells[start_i + 2].get_text(strip=True) if start_i + 2 < len(cells) else ""
                    do_val = cells[start_i + 3].get_text(strip=True) if start_i + 3 < len(cells) else ""
                    
                    cal.append({
                        "date": dt_txt,
                        "day": day_val,
                        "description": desc_val,
                        "dayOrder": do_val
                    })

                    if block_idx == month_block_index and dt_txt == current_day_num:
                        day_order = do_val if do_val else "-"

            if cal:
                return cal, day_order

        # 2. Portal Style Table Parsing (AcademicCalenderDetails.jsp)
        for t in soup.find_all('table'):
            for r in t.find_all('tr'):
                cells = [c.get_text(strip=True) for c in r.find_all(['td', 'th'])]
                if not cells:
                    continue
                if len(cells) >= 3 and any(char.isdigit() for char in cells[0]):
                    dt_txt = cells[0]
                    day_val = cells[1] if len(cells) > 1 else ""
                    desc_val = cells[2] if len(cells) > 2 else ""
                    do_val = cells[3] if len(cells) > 3 else "-"

                    cal.append({
                        "date": dt_txt,
                        "day": day_val,
                        "description": desc_val,
                        "dayOrder": do_val
                    })
                    if dt_txt == current_day_num and do_val != "-":
                        day_order = do_val

        return cal, day_order