from django.db.models.expressions import RawSQL
from django.http import JsonResponse
from rest_framework import permissions, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Entry


class EntryViewSet(viewsets.ModelViewSet):  # EXPECT: S7 idor-no-owner
    queryset = Entry.objects.all()
    permission_classes = [permissions.IsAuthenticated]


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def me(request):  # SAFE: S1
    return Response({"id": request.user.id})


class ReportView(APIView):  # EXPECT: S1 unauth-report  # EXPECT: S7 idor-no-owner
    permission_classes = [permissions.AllowAny]

    def get(self, request, pk):
        entry = Entry.objects.get(pk=pk)
        return Response({"memo": entry.memo, "cents": entry.cents})


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def monthly_total(request):
    month = request.query_params["month"]
    rows = Entry.objects.filter(owner=request.user).extra(where=["strftime('%%m', created) = '%s'" % month])  # EXPECT: S2 sqli
    total = Entry.objects.annotate(v=RawSQL("SELECT cents FROM ledger_entry WHERE memo = '" + month + "'", [])).count()  # EXPECT: S2 sqli
    return Response({"n": rows.count(), "t": total})


@api_view(["GET"])
@permission_classes([permissions.IsAuthenticated])
def entry_export(request, pk):
    entry = Entry.objects.filter(pk=pk, owner=request.user).first()  # SAFE: S7
    return JsonResponse({"memo": entry.memo if entry else None})
