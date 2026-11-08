---
{
  "id": "fixture-delete",
  "filename": "delete",
  "filetype": "document",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "meta": {
    "suggestions": {
      "enabled": true,
      "baselineContent": "one\ntwo\nthree",
      "proposedContent": "one\nthree",
      "items": {
        "delete-1": {
          "id": "delete-1",
          "oldStart": 1,
          "oldEnd": 2,
          "newStart": 1,
          "newEnd": 1,
          "oldLines": [
            "two"
          ],
          "newLines": [],
          "oldLineNumber": 2,
          "lineNumber": 2,
          "oldLineCount": 1,
          "newLineCount": 0,
          "oldContent": "two",
          "newContent": "",
          "changeType": "deleted",
          "applied": false,
          "suggestedAt": "2026-01-01T00:00:00.000Z",
          "suggestedBy": {
            "id": "fixture-author-1",
            "name": "Fixture author"
          }
        }
      }
    },
    "extensionExample": {
      "preserve": true
    }
  }
}
---
one
two
three