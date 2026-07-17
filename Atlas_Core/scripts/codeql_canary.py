"""Intentionally vulnerable CodeQL canary. DO NOT MERGE."""

import os

from flask import request


def codeql_command_injection_canary():
    os.system(request.args["command"])
