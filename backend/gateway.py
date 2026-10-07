"""Мост CGI для малой нагрузки на тарифе REG.RU без постоянного Python-процесса."""
import os
import sys
from wsgiref.handlers import CGIHandler
from passenger_wsgi import application

CGIHandler().run(application)
# Ответ уже записан, транзакции SQLite закрыты. Выходим без уборки памяти интерпретатором:
# освобождение сотен тысяч объектов индекса нот стоило ~0,1 с процессора на каждый запрос.
sys.stdout.flush()
sys.stderr.flush()
os._exit(0)
