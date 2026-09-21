import unittest
from planning_eligibility import approval_wait_reason


class ApprovalTests(unittest.TestCase):
    def test_waiting_work_is_not_authorized_by_accepted_dossier(self):
        for summary in [
            'The estimate was published; status pending agent response.',
            'Client sign-off and budget approval are not confirmed. Awaiting client approval.',
            'Pending Client Review & Sign-off',
            'Оценка подготовлена. Ждём клиента.',
            'Клиентский sign-off и утверждение бюджета не подтверждены.',
            'Бюджет не согласован.',
        ]:
            with self.subTest(summary=summary):
                self.assertIsNotNone(approval_wait_reason({'projection': {'summary': summary}}))

    def test_latest_approved_projection_supersedes_historical_waiting(self):
        dossier = {'projection': {'summary': 'The client approved the estimate and authorized implementation.',
                                  'nextStep': 'Implement the approved change.'},
                   'facts': [{'text': 'Pending client response'}],
                   'proposals': [{'status': 'pending', 'text': 'Pending client response'}]}
        self.assertIsNone(approval_wait_reason(dossier))

    def test_explicit_estimation_assignment_and_other_blockers_are_not_approval_waits(self):
        self.assertIsNone(approval_wait_reason({'projection': {
            'summary': 'The customer requested an estimate before deciding on implementation.',
            'nextStep': 'Prepare the requested estimate.', 'blockers': ['The test environment is unavailable.']}}))

    def test_waiting_blocker_is_checked(self):
        self.assertIsNotNone(approval_wait_reason({'projection': {
            'summary': 'The design is ready.', 'blockers': ['Awaiting budget approval.']}}))


if __name__ == '__main__':
    unittest.main()
