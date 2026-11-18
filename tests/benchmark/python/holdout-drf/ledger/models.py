from django.conf import settings
from django.db import models


class Entry(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    memo = models.CharField(max_length=200)
    cents = models.BigIntegerField()
