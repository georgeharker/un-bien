import Foundation

// birthEntry — the ENTRY replay funnel — carved from SessionState.swift
// (line cap). Every backfilled entry's rows are born here: compaction
// markers, user/assistant messages (identify match -> re-key; miss ->
// durable birth + tool-card reconstruction), toolResults, and custom
// notices (the replay half of the mesh-message path: the display flag
// rides the entry's message; the deterministic content-keyed notice id
// dedups a live birth against this replay). Applies through applyRPC —
// the same reducer entry the live wire uses, so entry-replay and live
// births share one code path.
extension SessionState {
    /// Birth ONE entry's rows — the pre-Stage-0 fold body, verbatim: compaction
    /// markers, user/assistant messages (identify match → in-place re-key;
    /// miss → durable birth + tool-card reconstruction), toolResults.
    mutating func birthEntry(_ entry: JSONValue) {
        switch entry["type"]?.stringValue {
        case "compaction":
            // Entry-born markers key on the entry id (dedup — a replayed
            // live marker used to duplicate the row).
            applyRPC(.object(["type": .string("compaction_end"),
                              "result": .object(["summary": entry["summary"] ?? .string(""),
                                                 "tokensBefore": entry["tokensBefore"] ?? .number(0)]),
                              "entryId": entry["id"] ?? .null]))
        case "custom_message":
            // pi's dedicated entry type for custom-role messages — the shape
            // DIFFERS from type:"message": content + display are TOP-LEVEL
            // (no message object). Mesh agent messages ride this type
            // (customType "un-bien:mesh-message", display:true); extension
            // bookkeeping rides it with display:false (name-assigned,
            // relay-state). Route through the SAME applyRPC funnel as the
            // live path so the display check + deterministic-id notice
            // birth are one code path.
            let display = entry["display"]?.boolValue ?? true
            guard display else { return }
            applyRPC(.object(["type": .string("message_end"),
                              "message": .object(["role": .string("custom"),
                                                  "timestamp": .number(0),
                                                  "display": .bool(display),
                                                  "content": entry["content"] ?? .string("")]),
                              "entryId": entry["id"] ?? .null]))
        case "message":
            guard let msg = entry["message"] else { return }
            switch msg["role"]?.stringValue {
            case "user", "assistant":
                let entryID = entry["id"]?.stringValue
                let key = Self.identify(msg)
                if let existingRowID = identifyIndex[key], let entryID {
                    // MATCH: this entry IS an already-born row (a live
                    // pending or a prior entry birth) — re-key it to the
                    // durable id. Never append: the content is already on
                    // screen. (A batched delta re-keys several at once; a
                    // same-id re-key no-ops via the appendedIDs guard.)
                    if let newRowID = rekeyRow(rowID: existingRowID, toEntryID: entryID) {
                        identifyIndex[key] = newRowID
                    }
                } else {
                    // Fresh birth FROM the entry (backfill / no live row):
                    // born durable + anchorable. The id-less fallback is
                    // defensive only — pi entries always carry ids.
                    applyRPC(.object(["type": .string("message_end"), "message": msg,
                                      "entryId": entry["id"] ?? .null]))
                    // Reconstruct tool cards from the assistant's toolCall blocks
                    // (the live stream opens them via separate tool_execution_start
                    // frames; here they ride the message content).
                    if msg["role"]?.stringValue == "assistant", let content = msg["content"]?.arrayValue {
                        for block in content where block["type"]?.stringValue == "toolCall" {
                            applyRPC(.object(["type": .string("tool_execution_start"),
                                              "toolCallId": block["id"] ?? .string(""),
                                              "toolName": block["name"] ?? .string(""),
                                              "args": block["arguments"] ?? .object([:]),
                                              "fromEntry": .bool(true)]))
                        }
                    }
                }
            case "custom":
                // ENTRY-BORN custom notices (the replay half of the mesh
                // message path): live message_end births them when the app
                // is connected at arrival; this branch births them on
                // backfill so a relapse never loses mesh messages. The
                // display flag rides the entry's message — same check, same
                // birth code, and the deterministic content-keyed id dedups
                // the live birth against this replay.
                applyRPC(.object(["type": .string("message_end"),
                                  "message": msg,
                                  "entryId": entry["id"] ?? .null]))
            case "toolResult":
                applyRPC(.object(["type": .string("tool_execution_end"),
                                  "toolCallId": msg["toolCallId"] ?? .string(""),
                                  "result": msg["content"] ?? .null,
                                  "isError": msg["isError"] ?? .bool(false)]))
            default:
                break
            }
        default:
            break  // model_change / thinking_level_change / label / ... : not transcript rows
        }
    }
}
