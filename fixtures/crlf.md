---
{
  "id": "fixture-crlf",
  "filename": "crlf",
  "filetype": "document",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "meta": {
    "suggestions": {
      "enabled": true,
      "baselineContent": "one\ntwo\n",
      "proposedContent": "one\nTWO\n",
      "items": {
        "crlf-1": {
          "id": "crlf-1",
          "oldStart": 1,
          "oldEnd": 2,
          "newStart": 1,
          "newEnd": 2,
          "oldLines": [
            "two"
          ],
          "newLines": [
            "TWO"
          ],
          "oldLineNumber": 2,
          "lineNumber": 2,
          "oldLineCount": 1,
          "newLineCount": 1,
          "oldContent": "two",
          "newContent": "TWO",
          "changeType": "modified",
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
