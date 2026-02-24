---
name: email-send
description: Send emails and search contacts via MCP tools. Only available to groups with email access enabled.
allowed-tools: mcp__nanoclaw__send_email, mcp__nanoclaw__search_contacts
---

# Email Sending

## Tools

Two MCP tools are available when email access is enabled:

### send_email
Send an email from jibot@ito.com.
- **to** (required): Recipient email address
- **subject** (required): Subject line
- **body** (required): Email body text
- **cc** (optional): CC addresses, comma-separated
- **bcc** (optional): BCC addresses, comma-separated

### search_contacts
Search Google Contacts by name or email.
- **query** (required): Name or email to search for
- Returns contact names and email addresses as JSON

## Guidelines

- Always send from jibot@ito.com (hardcoded, cannot be changed)
- If the user says "email John", search contacts first to find John's email address
- Confirm the recipient and subject with the user before sending if there's any ambiguity
- For replies to existing threads, include context in the body since this sends a new email (not a thread reply)
