//! JSON API handlers, one module per resource.

pub mod me;
pub mod periods;
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

/// The server's current UTC day as a day number (see `day_number`). Users'
/// days are local, so only use it with a day of slack either way.
pub fn today_number() -> i64 {
    crate::db::unix_now().div_euclid(86_400)
}

/// The inverse of `day_number` (Howard Hinnant's `civil_from_days`), for tests
/// that need days relative to today.
#[cfg(test)]
pub fn day_string(number: i64) -> String {
    let z = number + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let date = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{date:02}")
}

/// Days since 1970-01-01 for a day that passed `is_valid_day`, for computing
/// distances between days (Howard Hinnant's `days_from_civil`).
pub fn day_number(day: &str) -> i64 {
    let part = |range: std::ops::Range<usize>| day[range].parse::<i64>().unwrap_or(0);
    let (year, month, date) = (part(0..4), part(5..7), part(8..10));
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + date - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
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

    #[test]
    fn counts_days_between_dates() {
        assert_eq!(day_number("1970-01-01"), 0);
        assert_eq!(day_number("2000-03-01"), 11_017);
        assert_eq!(day_number("1969-12-31"), -1);
        assert_eq!(day_number("2026-10-27") - day_number("2026-10-20"), 7);
        assert_eq!(day_number("2024-03-01") - day_number("2024-02-28"), 2);
        assert_eq!(day_number("2026-01-01") - day_number("2025-12-31"), 1);
    }

    #[test]
    fn day_string_is_the_inverse_of_day_number() {
        for day in [
            "1970-01-01",
            "1969-12-31",
            "2000-02-29",
            "2024-12-31",
            "2026-10-27",
            "2100-03-01",
        ] {
            assert_eq!(day_string(day_number(day)), day);
        }
    }
}
