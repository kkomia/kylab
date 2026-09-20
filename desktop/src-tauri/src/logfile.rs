//! 壳的日志：一行一件事，落在配置目录下的 `kylab-desktop.log`。
//!
//! 这个壳做的事情少到不需要日志框架，但它有两件事**只能靠日志说清**：
//! 启动时到底连了哪儿（用户报"打开就是空白"时，第一句话就是问这个），
//! 以及导航被白名单拦掉时拦的是哪个地址。所以是"少而关键"的一份记录。
//!
//! 时间戳自己算：`std` 没有日期格式化，而为一个日志引 `chrono` 不值当。
//! 用 Howard Hinnant 的 `civil_from_days`（那套算法的标准写法）把它折成年月日。
//! **记的是 UTC**，并在每行写明——本地时区要读系统设置，而这个是排错用的。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 超过这个大小就从头写。排错只需要最近这一段，而日志无限长大是另一类事故。
const MAX_BYTES: u64 = 512 * 1024;

pub fn log(dir: &Path, line: &str) {
    let _ = append(dir, line).map_err(|error| {
        // 日志写不进去不能影响壳本身：没有日志也照样能连服务器
        eprintln!("写日志失败：{error}");
    });
}

fn append(dir: &Path, line: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("kylab-desktop.log");
    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
        std::fs::write(&path, "")?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{}  {line}", timestamp())
}

/// `2026-09-20 20:11:03 UTC`
fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// 从 1970-01-01 起的天数 → `(年, 月, 日)`。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = (days - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        // 期望值用独立的算法（Python 的 date 差值）算过，不是照着实现抄的
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
        assert_eq!(civil_from_days(20_716), (2026, 9, 20));
        assert_eq!(civil_from_days(20_725), (2026, 9, 29));
    }

    #[test]
    fn timestamp_looks_like_a_date() {
        let stamp = timestamp();
        assert!(stamp.ends_with(" UTC"), "{stamp}");
        assert_eq!(stamp.len(), "2026-09-20 20:11:03 UTC".len(), "{stamp}");
    }

    #[test]
    fn appends_instead_of_overwriting() {
        let dir = std::env::temp_dir().join("kylab-desktop-test-log");
        let _ = std::fs::remove_dir_all(&dir);
        log(&dir, "第一行");
        log(&dir, "第二行");
        let text = std::fs::read_to_string(dir.join("kylab-desktop.log")).unwrap();
        assert!(text.contains("第一行") && text.contains("第二行"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
