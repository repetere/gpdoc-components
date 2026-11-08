---
{
  "id": "fixture-repeated-text",
  "filename": "repeated-text",
  "filetype": "document",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "meta": {
    "suggestions": {
      "enabled": true,
      "baselineContent": "same\nsame\nsame",
      "proposedContent": "same\nchanged\nsame",
      "items": {
        "repeated-text-1": {
          "id": "repeated-text-1",
          "oldStart": 1,
          "oldEnd": 1,
          "newStart": 1,
          "newEnd": 2,
          "oldLines": [],
          "newLines": [
            "changed"
          ],
          "oldLineNumber": 2,
          "lineNumber": 2,
          "oldLineCount": 0,
          "newLineCount": 1,
          "oldContent": "",
          "newContent": "changed",
          "changeType": "added",
          "applied": false,
          "suggestedAt": "2026-01-01T00:00:00.000Z",
          "suggestedBy": {
            "id": "fixture-author-1",
            "name": "Fixture author"
          }
        },
        "repeated-text-3": {
          "id": "repeated-text-3",
          "oldStart": 2,
          "oldEnd": 3,
          "newStart": 3,
          "newEnd": 3,
          "oldLines": [
            "same"
          ],
          "newLines": [],
          "oldLineNumber": 3,
          "lineNumber": 4,
          "oldLineCount": 1,
          "newLineCount": 0,
          "oldContent": "same",
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
same
same
same