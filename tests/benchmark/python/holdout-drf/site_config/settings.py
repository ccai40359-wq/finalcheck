import os

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]  # SAFE: S3
DEBUG = os.environ.get("DJANGO_DEBUG", "0") == "1"  # SAFE: S5
ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "ledger.example.com").split(",")  # SAFE: S5
INSTALLED_APPS = ["django.contrib.auth", "django.contrib.contenttypes", "rest_framework", "corsheaders", "ledger"]
CORS_ALLOWED_ORIGINS = ["https://app.ledger.example.com"]  # SAFE: S5
CSRF_COOKIE_SECURE = False  # EXPECT: S8 insecure-cookie
SESSION_COOKIE_SECURE = True  # SAFE: S8
ROOT_URLCONF = "site_config.urls"
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
}
