#!/usr/bin/env python3
"""
Apple Reminders bridge for NanoClaw.
Uses EventKit via PyObjC. Reads JSON from stdin, outputs JSON to stdout.

Operations:
  list_lists      - List all reminder lists
  list_reminders  - List reminders (optional: list_name, include_completed)
  create_reminder - Create a reminder (title, list_name, due_date?, notes?, priority?)
  complete_reminder - Complete a reminder (reminder_id)
  update_reminder - Update a reminder (reminder_id, title?, due_date?, notes?, priority?)
  snapshot        - Full snapshot of all incomplete reminders (for cache file)
"""

import json
import sys
import threading
from datetime import datetime, timezone

import EventKit
import objc

# ── EventKit setup ──────────────────────────────────────────────

store = EventKit.EKEventStore.alloc().init()

def request_access():
    event = threading.Event()
    result = [False]
    def cb(granted, error):
        result[0] = granted
        event.set()
    store.requestFullAccessToRemindersWithCompletion_(cb)
    event.wait(timeout=10)
    if not result[0]:
        print(json.dumps({"error": "Reminders access denied. Grant permission in System Settings > Privacy & Security > Reminders."}))
        sys.exit(1)

def get_calendars():
    """Get all reminder calendars (lists)."""
    return store.calendarsForEntityType_(EventKit.EKEntityTypeReminder)

def find_calendar(name):
    """Find a calendar by name (case-insensitive)."""
    for cal in get_calendars():
        if cal.title().lower() == name.lower():
            return cal
    return None

def fetch_reminders(calendars=None, completed=False):
    """Fetch reminders synchronously."""
    if calendars is None:
        calendars = get_calendars()
    
    if completed:
        predicate = store.predicateForCompletedRemindersWithCompletionDateStarting_ending_calendars_(
            None, None, calendars
        )
    else:
        predicate = store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(
            None, None, calendars
        )
    
    event = threading.Event()
    results = [None]
    def cb(reminders):
        results[0] = reminders if reminders else []
        event.set()
    store.fetchRemindersMatchingPredicate_completion_(predicate, cb)
    event.wait(timeout=30)
    return results[0] or []

def reminder_to_dict(r):
    """Convert EKReminder to dict."""
    due = None
    if r.dueDateComponents():
        dc = r.dueDateComponents()
        try:
            due = f"{dc.year():04d}-{dc.month():02d}-{dc.day():02d}"
            if dc.hour() is not None and dc.hour() != 9223372036854775807:
                due += f"T{dc.hour():02d}:{dc.minute():02d}:00"
        except:
            pass
    
    cal = r.calendar()
    return {
        "id": r.calendarItemExternalIdentifier(),
        "title": r.title() or "",
        "list_name": cal.title() if cal else "Unknown",
        "completed": bool(r.isCompleted()),
        "due_date": due,
        "priority": int(r.priority()),
        "notes": r.notes() or "",
        "creation_date": r.creationDate().description() if r.creationDate() else None,
    }

# ── Operations ──────────────────────────────────────────────────

def op_list_lists(_params):
    cals = get_calendars()
    return {"lists": [{"name": c.title(), "id": c.calendarIdentifier()} for c in cals]}

def op_list_reminders(params):
    list_name = params.get("list_name")
    include_completed = params.get("include_completed", False)
    
    cals = None
    if list_name:
        cal = find_calendar(list_name)
        if not cal:
            return {"error": f"List {list_name} not found"}
        cals = [cal]
    
    reminders = fetch_reminders(cals, completed=False)
    result = [reminder_to_dict(r) for r in reminders]
    
    if include_completed:
        completed = fetch_reminders(cals, completed=True)
        result.extend(reminder_to_dict(r) for r in completed)
    
    # Sort: overdue first, then by due date
    def sort_key(r):
        if r["due_date"] is None:
            return (2, "9999")
        today = datetime.now().strftime("%Y-%m-%d")
        is_overdue = r["due_date"][:10] < today
        return (0 if is_overdue else 1, r["due_date"])
    
    result.sort(key=sort_key)
    return {"reminders": result, "count": len(result)}

def op_create_reminder(params):
    title = params.get("title")
    list_name = params.get("list_name", "Inbox")
    due_date = params.get("due_date")
    notes = params.get("notes")
    priority = params.get("priority", 0)
    
    if not title:
        return {"error": "title is required"}
    
    cal = find_calendar(list_name)
    if not cal:
        return {"error": f"List {list_name} not found"}
    
    reminder = EventKit.EKReminder.reminderWithEventStore_(store)
    reminder.setTitle_(title)
    reminder.setCalendar_(cal)
    reminder.setPriority_(priority)
    
    if notes:
        reminder.setNotes_(notes)
    
    if due_date:
        try:
            if "T" in due_date:
                dt = datetime.strptime(due_date, "%Y-%m-%dT%H:%M:%S")
            else:
                dt = datetime.strptime(due_date, "%Y-%m-%d")
            
            import Foundation
            nsdc = Foundation.NSDateComponents.alloc().init()
            nsdc.setYear_(dt.year)
            nsdc.setMonth_(dt.month)
            nsdc.setDay_(dt.day)
            if "T" in due_date:
                nsdc.setHour_(dt.hour)
                nsdc.setMinute_(dt.minute)
            reminder.setDueDateComponents_(nsdc)
        except Exception as e:
            return {"error": f"Invalid due_date format: {e}"}
    
    error = objc.nil
    success = store.saveReminder_commit_error_(reminder, True, None)
    if not success:
        return {"error": "Failed to save reminder"}
    
    return {"created": reminder_to_dict(reminder)}

def op_complete_reminder(params):
    reminder_id = params.get("reminder_id")
    title_match = params.get("title_match")
    
    if not reminder_id and not title_match:
        return {"error": "reminder_id or title_match required"}
    
    # Search across all lists
    reminders = fetch_reminders(completed=False)
    target = None
    for r in reminders:
        if reminder_id and r.calendarItemExternalIdentifier() == reminder_id:
            target = r
            break
        if title_match and title_match.lower() in (r.title() or "").lower():
            target = r
            break
    
    if not target:
        return {"error": f"Reminder not found"}
    
    target.setCompleted_(True)
    success = store.saveReminder_commit_error_(target, True, None)
    if not success:
        return {"error": "Failed to complete reminder"}
    
    return {"completed": reminder_to_dict(target)}

def op_update_reminder(params):
    reminder_id = params.get("reminder_id")
    title_match = params.get("title_match")
    
    if not reminder_id and not title_match:
        return {"error": "reminder_id or title_match required"}
    
    reminders = fetch_reminders(completed=False)
    target = None
    for r in reminders:
        if reminder_id and r.calendarItemExternalIdentifier() == reminder_id:
            target = r
            break
        if title_match and title_match.lower() in (r.title() or "").lower():
            target = r
            break
    
    if not target:
        return {"error": "Reminder not found"}
    
    if "title" in params:
        target.setTitle_(params["title"])
    if "notes" in params:
        target.setNotes_(params["notes"])
    if "priority" in params:
        target.setPriority_(params["priority"])
    if "list_name" in params:
        cal = find_calendar(params["list_name"])
        if cal:
            target.setCalendar_(cal)
    if "due_date" in params:
        import Foundation
        if params["due_date"]:
            dt = datetime.strptime(params["due_date"], "%Y-%m-%d")
            nsdc = Foundation.NSDateComponents.alloc().init()
            nsdc.setYear_(dt.year)
            nsdc.setMonth_(dt.month)
            nsdc.setDay_(dt.day)
            target.setDueDateComponents_(nsdc)
        else:
            target.setDueDateComponents_(None)
    
    success = store.saveReminder_commit_error_(target, True, None)
    if not success:
        return {"error": "Failed to update reminder"}
    
    return {"updated": reminder_to_dict(target)}

def op_snapshot(_params):
    """Full snapshot of all incomplete reminders for cache."""
    reminders = fetch_reminders(completed=False)
    result = [reminder_to_dict(r) for r in reminders]
    
    def sort_key(r):
        if r["due_date"] is None:
            return (2, "9999")
        today = datetime.now().strftime("%Y-%m-%d")
        return (0 if r["due_date"][:10] < today else 1, r["due_date"])
    
    result.sort(key=sort_key)
    
    lists = {}
    for r in result:
        ln = r["list_name"]
        if ln not in lists:
            lists[ln] = []
        lists[ln].append(r)
    
    return {
        "reminders": result,
        "by_list": lists,
        "total": len(result),
        "timestamp": datetime.now().isoformat(),
    }

# ── Main ────────────────────────────────────────────────────────

OPS = {
    "list_lists": op_list_lists,
    "list_reminders": op_list_reminders,
    "create_reminder": op_create_reminder,
    "complete_reminder": op_complete_reminder,
    "update_reminder": op_update_reminder,
    "snapshot": op_snapshot,
}

def main():
    request_access()
    
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"error": "No input"}))
        sys.exit(1)
    
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
        sys.exit(1)
    
    op = req.get("operation")
    if op not in OPS:
        print(json.dumps({"error": f"Unknown operation: {op}. Valid: {list(OPS.keys())}"}))
        sys.exit(1)
    
    try:
        result = OPS[op](req.get("params", {}))
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
