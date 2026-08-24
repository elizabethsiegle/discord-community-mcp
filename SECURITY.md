# Security

## Sensitive data

Discord bot tokens are credentials. Never commit a token, paste it into an issue, or include it in logs. If a token is exposed, reset it immediately in the Discord Developer Portal.

The analytics database contains unencrypted Discord message content and member metadata. Store it in a private location, limit retention, and handle it according to the community's privacy policy.

## Reporting a vulnerability

Do not include credentials, private Discord content, or member data in a public GitHub issue. Share only the minimum reproducible technical details needed to describe the problem.
