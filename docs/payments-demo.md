# The payments demo

The corpus every reader answers from in [the evidence](evidence.md): 30 statements of a payments team's on-call practice, by role. The cases are the circumstances some questions are asked in.

| Role | Statement |
| ---- | --------- |
| incident commander | Maya, the incident commander, declares a major incident when payment failures last more than ten minutes. |
| incident commander | Maya, the incident commander, may approve a rollback of the payments service. |
| incident commander | Maya, the incident commander, must close a major incident after the release manager confirms that payments are healthy. |
| incident commander | Maya, the incident commander, approves the database vendor invoice. |
| incident commander | On Friday payment failures lasted more than ten minutes, and Maya, the incident commander, did not declare a major incident. |
| on call engineer | Alex, the on-call engineer, acknowledges every page within five minutes. |
| on call engineer | Alex, the on-call engineer, checks the payment error rate after acknowledging a page. |
| on call engineer | Alex, the on-call engineer, may restart the payments service when the error rate stays above five percent. |
| on call engineer | Alex, the on-call engineer, reviews access logs after every rollback. |
| release manager | Morgan, the release manager, freezes deployments during a major incident. |
| release manager | Morgan, the release manager, may roll back the latest payments release after the incident commander approves the rollback. |
| release manager | Morgan, the release manager, confirms that payments are healthy before the incident commander closes a major incident. |
| release manager | A deployment is a change. |
| release manager | If a major incident is open, Morgan, the release manager, does not ship a release. |
| release manager | If a payment key leaks, Morgan, the release manager, ships a release. |
| support lead | Sam, the support lead, posts customer updates after the incident commander declares a major incident. |
| support lead | Sam, the support lead, must not promise a recovery time before the on-call engineer identifies the cause. |
| support lead | Sam, the support lead, collects affected customer reports in the incident channel. |
| support lead | If Priya renews the certificate, Sam, the support lead, notifies the customers. |
| database administrator | Jordan, the database administrator, may fail over the primary database after the on-call engineer confirms replication lag. |
| database administrator | Jordan, the database administrator, keeps break-glass credentials in the password vault. |
| database administrator | Jordan, the database administrator, may restore the database from a backup only after the incident commander approves the restore. |
| database administrator | Jordan, the database administrator, tests a backup before restoring it. |
| security engineer | Priya, the security engineer, reviews access logs when a payment key is exposed. |
| security engineer | Priya, the security engineer, must rotate a leaked payment key before the incident commander closes the incident. |
| security engineer | Priya, the security engineer, reports a leaked payment key to the incident commander. |
| security engineer | If a certificate expires, Priya, the security engineer, renews the certificate. |
| security engineer | If a payment key leaks, Priya, the security engineer, renews the certificate. |
| security engineer | Either a certificate expires or a payment key leaks. |
| security engineer | If Priya reviews access logs, she files an audit note. |

## The cases

- A certificate expires.
- A major incident is open.
- The incident commander has approved the restore.
- The incident commander has not approved the restore.
