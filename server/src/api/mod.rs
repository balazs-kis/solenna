//! JSON API handlers, one module per resource.

pub mod me;
pub mod weights;

/// A real calendar date in `YYYY-MM-DD` form (the user's local day), between
/// 1900 and 2100. Rejects things like `2026-02-30` that only look like dates.
pub fn is_valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = &day[range];
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (Some(year), Some(month), Some(date)) = (number(0..4), number(5..7), number(8..10)) else {
        return false;
    };

    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1900..=2100).contains(&year) && (1..=days_in_month).contains(&date)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_calendar_days() {
        for day in [
            "2026-10-26",
            "2024-02-29",
            "2000-02-29",
            "1900-01-01",
            "2100-12-31",
        ] {
            assert!(is_valid_day(day), "{day}");
        }
        for day in [
            "2026-02-29",
            "1900-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-04-31",
            "2026-01-00",
            "2026-1-01",
            "26-01-01",
            "2026/01/01",
            "2026-01-01T00",
            "1899-12-31",
            "+026-01-01",
            "２０２６-01-01",
            "",
        ] {
            assert!(!is_valid_day(day), "{day}");
        }
    }
}
