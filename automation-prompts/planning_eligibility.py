"""Conservative approval checks for script-based day planners.

Accepted dossier content is not permission to start the described work. These
checks catch explicit waiting states in the current projection. The planner must
also assess the actual assignment; a missing match is not proof of approval.
"""
import re

_WAITING = re.compile(
    r"\bpending\s+(?:agent|client|customer|fc)\s+(?:response|review|approval)\b"
    r"|\b(?:awaiting|waiting\s+(?:for|on))\s+(?:(?:the|a)\s+)?(?:client|customer|fc|agent|budget|scope|estimate|approval|sign[- ]?off)\b"
    r"|\b(?:client|customer|budget|scope|estimate)\s+(?:approval|sign[- ]?off)\s+(?:is\s+)?(?:pending|not\s+(?:confirmed|approved|received))\b"
    r"|\b(?:not\s+yet\s+approved|not\s+approved\s+(?:by|for)|approval\s+(?:is\s+)?(?:required|pending))\b"
    r"|(?:жд[её]м|ожидаем|ожидает|ожидание)\s+(?:ответа?\s+)?(?:клиента|заказчика|fc|согласования|одобрения|подтверждения|подписания)"
    r"|(?:клиентск\w*\s+(?:sign[- ]?off|подписан\w*|согласован\w*)|(?:утвержден|согласован|одобрен)\w*\s+(?:бюджет|оценк|работ)\w*|(?:бюджет|оценк)\w*)[^.!?\n]{0,140}\bне\s+(?:подтвержден|согласован|утвержден|одобрен)\w*"
    r"|\b(?:нет|без)\s+(?:клиентского\s+)?(?:согласования|одобрения|подтверждения|разрешения\s+на\s+(?:начало|выполнение))",
    re.IGNORECASE,
)


def approval_wait_reason(dossier):
    """Return an explicit waiting reason, without reading pending proposals.

    Use the current accepted projection, not the full historical fact stream:
    an old waiting state must not block a later approved assignment forever.
    """
    projection = dossier.get('projection') or {}
    texts = [projection.get('summary'), projection.get('nextStep'), *(projection.get('blockers') or [])]
    for text in texts:
        if text and _WAITING.search(text):
            return 'Work is awaiting approval or an external response: ' + _WAITING.search(text).group(0)
    return None
