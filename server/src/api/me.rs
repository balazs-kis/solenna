use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::{AppState, auth::CurrentUser, error::AppError};

/// The signed-in user's profile. 401 when not signed in, which is how the
/// frontend decides to show the login screen.
pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let (email, name): (String, String) = state
        .db
        .call(move |conn| {
            Ok(conn.query_row(
                "SELECT email, name FROM users WHERE id = ?",
                [user.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await?;
    Ok(Json(json!({ "email": email, "name": name })))
}
